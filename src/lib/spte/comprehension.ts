// THE COMPREHENSION PASS - understanding the shop's message is a MODEL
// judgement over the thread, not a regex over the current frame.
//
// The owner's doctrine, verbatim: "In any matter or issue that related to miss
// understand logic of our ai agents, we should never use if/else. We should use
// the pros of AI and use the most advanced architectures of this era."
//
// Three live failures shared one cause. The engine rebuilt every negotiation
// fact from the CURRENT inbound message using English-only regexes:
//
//   - "You should try asking other shops; maybe they'll give you one." No
//     category existed for being sent away, so the ladder fell through to its
//     "no price yet" default and re-asked the daily rate.
//   - "We have deposit passport or money4000." `depositKnown` latched on the
//     bare word "passport" and whichever reading the extractor took became
//     permanent - there was no way to ask "wait, do you mean either one?".
//   - "300 baht." then "ok for you?" - the second message has no number, so
//     priceKnown went false and the engine forgot the quote it had.
//
// The machinery to fix the first two ALREADY EXISTED and had zero callers:
// semantic/parse.ts is a zod-validated LLM parse with schema-violation retry
// and provider provenance, and semantic/classifiers.ts holds typed judgements
// including `readAvailability`, which returns exactly the state the stock-out
// branch needs and says in its own schema that "none" is not a refusal to deal.
//
// WHAT THIS MODULE IS NOT. It is not a rail. Money math, the number-integrity
// guards and pacing stay deterministic - a guarantee that depends on an LLM
// being reachable is not a guarantee. This reads the shop's INPUT; the rails
// still constrain our OUTPUT, and every threshold below is arithmetic over a
// model's own stated confidence, never a phrase list.
//
// AND WHEN NO PROVIDER ANSWERS. `degraded` says so, the caller keeps today's
// deterministic reads, and nothing new becomes legal - an AI outage degrades to
// the behaviour that shipped before this file existed rather than freezing a
// turn or inventing a verdict.

import "server-only";
import type { ConfirmSubject, PendingConfirm, ShopStance, Uncertainty } from "./types";
import type { ClaimSubject } from "../thread/claims";
import type { LanguageStatement } from "../wa/thread-language";

/**
 * How sure the model has to be before a stance ENDS a negotiation.
 *
 * Arithmetic on a model judgement, which is the only kind of threshold this
 * file has. Deliberately high: a false "engaged" costs one more question, a
 * false "deflecting" costs the whole shop. Stances below it read as engaged,
 * which is exactly today's behaviour.
 */
export const STANCE_CONFIDENCE_FLOOR = 0.6;

/**
 * How sure the model has to be that a fact is worth CONFIRMING.
 *
 * Lower than the stance floor and for the opposite reason: the cost of a
 * needless confirming question is one polite message, while the cost of
 * latching a misread deposit is a traveller who hands over a passport they
 * were told they could replace with cash.
 */
export const UNCERTAINTY_CONFIDENCE_FLOOR = 0.4;

/**
 * How sure the model has to be that the shop ANSWERED our confirming question.
 *
 * The asymmetry runs the other way from the stance floor. A false "they
 * answered" ends the wait and lets the engine act on a reading the shop never
 * confirmed - which is the entire failure this doctrine exists to prevent. A
 * false "not yet" costs one more turn of patience, and the turn bound
 * (CONFIRM_WAIT_TURNS) means it can never cost more than three.
 */
export const CONFIRM_ANSWER_FLOOR = 0.6;

/**
 * How sure the model has to be that the shop REFUSED TO GO LOWER.
 *
 * Same height as the stance floor, and for the same reason: firmness retires
 * bargaining (two of them and spte/policy stops pushing), so a false positive
 * costs the traveller the discount the whole app exists to find, while a false
 * negative costs one more polite question. Below the floor the read is kept for
 * the trace and nothing retires - i.e. WE KEEP BARGAINING, which is the side
 * the owner's "we are not bargaining enough" points at.
 */
export const FIRMNESS_CONFIDENCE_FLOOR = 0.6;

/**
 * How sure the model has to be that the shop STATED A TERM (deposit, handover
 * mode, handover price).
 *
 * Lower than the two above because the asymmetry is milder and runs the other
 * way: a false "they told us" retires a question that then never gets asked
 * (this is exactly how the delivery fee stopped being asked about - see
 * ThreadComprehension.handover), while a false "not yet" costs one polite
 * question. So: moderate confidence to mark a term KNOWN, and unknown-by-
 * default whenever the model is unsure or absent.
 */
export const TERMS_CONFIDENCE_FLOOR = 0.5;

/**
 * The whole comprehension phase's wall clock.
 *
 * The reply path budgets ~9s for the single pass (spte/pass.ts) inside a 45s
 * serverless turn. The three reads below run in PARALLEL, so this is the wall
 * clock of the slowest one, not their sum - and the race below makes it a hard
 * ceiling regardless of what any provider does.
 */
export const COMPREHENSION_BUDGET_MS = 7_000;

export interface TurnComprehension {
  stance: ShopStance;
  stanceQuote?: string;
  stanceReason?: string;
  /** Terminal-and-polite: they are getting rid of us without a refusal word. */
  deflected: boolean;
  /**
   * TERMINAL-AND-EXPLICIT: an outright end, and THE MODEL OWNS IT.
   *
   * This used to be OR-ed with `DECLINED_RX` (agents.ts) in two places at once -
   * into the extractor's verdict and again over this one - so the model was
   * structurally forbidden from saying "no, they are still selling". One
   * ordinary sentence killed a live shop: "Sorry cannot deliver to your hotel,
   * you come to shop. Scooter 300 baht per day" matched `sorry,? cannot`, and a
   * shop QUOTING A PRICE was filed as one that had walked away. The regex is now
   * a pre-filter only (agents.looksLikeWalkAway) that can buy a stronger model
   * call and nothing else.
   */
  declined: boolean;
  /**
   * THE SHOP EXPLICITLY REFUSED TO GO LOWER (A2). Above
   * FIRMNESS_CONFIDENCE_FLOOR, and only for a stated refusal - never for the
   * "best price" that opens a sale. Undefined when no model answered, which
   * reads downstream as "no refusal seen" and keeps us bargaining.
   */
  firm?: boolean;
  /** Their own words for the refusal, so the trace can quote rather than claim. */
  firmQuote?: string;
  /**
   * WHAT THEY WANT HELD (A5). `readDepositTerms` has run on every turn since it
   * shipped and everything except a narrow cash-or-document ambiguity flag was
   * thrown on the floor, while DEPOSIT_RX - the bare word "passport" anywhere in
   * any inbound message - decided the fact. This is the structured answer we
   * were already paying for.
   */
  deposit?: {
    stated: boolean;
    kind: "cash" | "document" | "cash-or-document" | "card" | "none" | "unclear";
    amount?: number;
    currency?: string;
    document?: string;
    confidence: number;
  };
  /** HOW THE VEHICLE CHANGES HANDS AND WHAT THAT COSTS (A5) - the mode and its
   *  price kept as two facts, because one flag answering for both is what
   *  stopped anyone asking what delivery costs. */
  handover?: {
    mode: "delivery" | "pickup" | "both" | "unstated";
    costStated: boolean;
    cost?: number;
    currency?: string;
    confidence: number;
  };
  /** The availability read, from the classifier that had zero callers. */
  availability?: "has" | "none" | "later" | "unclear";
  restockHint?: string;
  /** The shop used "free" to mean AT NO COST, not "in stock". */
  freeMeansNoCost?: boolean;
  /** Facts worth putting back as a question, already phrased. */
  uncertain: Uncertainty[];
  /**
   * W4.6 - THE SHOP STATED A LANGUAGE PREFERENCE.
   *
   * Only ever set for an EXPLICIT statement ("I don't speak Thai", "English
   * please"), never for a message that merely happens to be in English. The
   * doctrine that consumes it lives in wa/thread-language.nextThreadLanguage,
   * which also holds the confidence floor - this pass reports what it read and
   * decides nothing.
   */
  languageRequest?: LanguageStatement;
  /** No provider answered - the caller must keep its deterministic reads. */
  degraded: boolean;
  /** Which provider answered the stance read (telemetry). */
  provider?: string;
  /** Wall clock actually spent, so the budget can be watched in Ops. */
  ms: number;
}

export function emptyComprehension(): TurnComprehension {
  return { stance: "unclear", deflected: false, declined: false, uncertain: [], degraded: true, ms: 0 };
}

/** ConfirmSubjects that are also ledger subjects - the three the ask-once book
 *  actually keys on. `conditions` and `vehicle` have no claim subject, so they
 *  reach the ladder through `verified.uncertain` alone. */
const LEDGER_SUBJECT: Partial<Record<ConfirmSubject, ClaimSubject>> = {
  deposit: "deposit",
  price: "price",
  availability: "availability",
};

/** The ledger subjects this turn must treat as ANSWERED-BUT-NOT-UNDERSTOOD. */
export function ambiguousLedgerSubjects(c: TurnComprehension | null | undefined): ClaimSubject[] {
  const out: ClaimSubject[] = [];
  for (const u of c?.uncertain ?? []) {
    const s = LEDGER_SUBJECT[u.subject];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * IS THIS A TURN WORTH THE STRONGEST BRAIN?
 *
 * `pickRoute` already escalates COMPOSITION to the paid providers when the turn
 * can end a thread. Reading the message is the other half of the same decision
 * and was pinned to the free chain. High stakes here means: the thread has no
 * price yet (a misread brush-off silently kills a shop that never quoted), the
 * shop is already flagged as refusing or firm, or the vehicle itself is in
 * doubt. Everything else - an ordinary priced turn mid-negotiation - runs on
 * the free chain, which is where the volume is.
 *
 * Pure, so the routing rule is testable without a model.
 */
export function isHighStakesComprehension(args: {
  hasStandingPrice: boolean;
  declined?: boolean;
  firm?: boolean;
  vehicleUnclear?: boolean;
}): boolean {
  return (
    !args.hasStandingPrice ||
    args.declined === true ||
    args.firm === true ||
    args.vehicleUnclear === true
  );
}

/** Race a promise against the phase budget. A provider that hangs must cost the
 *  turn its comprehension, never its reply. */
async function withCeiling<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ComprehensionInput {
  /**
   * THE TEXT THE JUDGEMENT IS MADE ON.
   *
   * The English gloss when one exists (W1.5 ships it on both inbound surfaces),
   * because English-only judgement over raw Thai is the root of every misread
   * in this wave. Raw text otherwise - a missing gloss must degrade to reading
   * the shop's own words, never to reading nothing.
   */
  text: string;
  /** What the traveller asked for + what this thread has established. */
  context?: string;
  /** Escalate the reads to the paid chain (isHighStakesComprehension). */
  highStakes?: boolean;
  /** Test seam / tighter caller budget. Defaults to COMPREHENSION_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * Read one shop turn: where they stand, whether they have a vehicle, what they
 * want held, and what we are not sure we understood.
 *
 * Three parallel typed judgements rather than one mega-prompt, deliberately:
 * each has its own schema, its own retry and its own failure mode, so a
 * provider that mangles the deposit shape cannot take the stance read down with
 * it. Never throws.
 */
export async function readTurnComprehension(
  input: ComprehensionInput
): Promise<TurnComprehension> {
  const started = Date.now();
  const text = (input.text ?? "").trim();
  if (!text) return { ...emptyComprehension(), degraded: false, stance: "unclear" };

  const budget = input.budgetMs ?? COMPREHENSION_BUDGET_MS;
  const tier = input.highStakes ? ("premium" as const) : undefined;
  // Per-call budget sits under the phase ceiling so a well-behaved provider
  // fails over inside the race rather than being cut off by it.
  const per = Math.max(2_000, Math.floor(budget * 0.8));

  const { readComprehension, readAvailability, readDepositTerms } = await import(
    "../semantic/classifiers"
  );

  /** The shape a read that never ran returns - a caught throw, or the ceiling
   *  firing. `degraded:true` is the honest report either way. */
  const dead: {
    value: null;
    degraded: true;
    attempts: 0;
    provider?: import("../ai").ProviderName;
  } = { value: null, degraded: true, attempts: 0 };
  const [comp, avail, deposit] = await withCeiling(
    Promise.all([
      readComprehension(text, input.context, { budgetMs: per, tier, once: true }).catch(() => dead),
      readAvailability(text, input.context, { budgetMs: per, tier, once: true }).catch(() => dead),
      readDepositTerms(text, input.context, { budgetMs: per, tier, once: true }).catch(() => dead),
    ]),
    budget,
    [dead, dead, dead] as const
  );

  const c = comp.value;
  const ms = Date.now() - started;

  // THE DEPOSIT ANSWER WE WERE ALREADY PAYING FOR (A5). Carried whether or not
  // the stance read survived: these are three independent calls with three
  // independent failure modes, and a mangled stance shape must not throw away a
  // clean deposit read. Below the terms floor it is dropped entirely - unknown,
  // so we ask, which costs one message.
  const dep = deposit.value;
  const depositRead: TurnComprehension["deposit"] =
    dep && dep.confidence >= TERMS_CONFIDENCE_FLOOR
      ? {
          stated: dep.stated === true,
          kind: dep.kind,
          ...(typeof dep.amount === "number" ? { amount: dep.amount } : {}),
          ...(dep.currency ? { currency: dep.currency } : {}),
          ...(dep.document ? { document: dep.document } : {}),
          confidence: dep.confidence,
        }
      : undefined;

  // NO PROVIDER ANSWERED THE STANCE READ. Everything terminal below is derived
  // from it, so this is the honest degrade: say so and change nothing. The
  // caller keeps its deterministic reads and the ladder behaves exactly as it
  // did before this module existed.
  if (!c) {
    return {
      ...emptyComprehension(),
      degraded: comp.degraded !== false,
      provider: comp.provider,
      ms,
      // The availability classifier may still have answered; a stock-out read
      // is not terminal, so it is safe to carry on its own.
      availability: avail.value?.state,
      restockHint: avail.value?.backWhen ?? undefined,
      freeMeansNoCost: avail.value?.freeMeansNoCost ?? undefined,
      // Same reasoning as `availability` above: an independent call answered,
      // and a deposit read is not terminal, so it is safe to carry on its own.
      ...(depositRead ? { deposit: depositRead } : {}),
      // NO FIRMNESS AND NO HANDOVER READ. Both live on the stance schema, which
      // is the read that failed. Left undefined on purpose: "we did not find out"
      // keeps us bargaining and keeps the handover questions askable, and that
      // is the only honest degrade - an outage may never manufacture a refusal.
    };
  }

  // A STANCE ONLY ENDS A THREAD IF THE MODEL IS SURE. Below the floor the
  // verdict is kept for the trace and the prompt, but nothing terminal fires.
  const sure = c.confidence >= STANCE_CONFIDENCE_FLOOR;

  // ...AND A STOCK-OUT IS NEVER A BRUSH-OFF. `readAvailability`'s own schema
  // says "none" means a stock-out, "not a refusal to deal" - so a shop with
  // nothing to rent today can never be filed as one that sent us away, however
  // apologetic the sentence was. This is the same precedence the ladder uses
  // (stock outranks decline) enforced one layer earlier, on the READING.
  const stockOut = avail.value?.state === "none";

  const uncertain: Uncertainty[] = (c.uncertain ?? [])
    .filter((u) => u.confidence >= UNCERTAINTY_CONFIDENCE_FLOOR)
    .map((u) => ({
      subject: u.subject as ConfirmSubject,
      reading: u.reading,
      question: u.question,
      confidence: u.confidence,
    }));

  // A DEPOSIT STATED AS A CHOICE IS AMBIGUOUS BY CONSTRUCTION.
  //
  // "We have deposit passport or money4000" is `kind: "cash-or-document"`, and
  // that is not a fact the traveller can act on - it is two facts they get to
  // pick between, and the difference is a passport. The stance model usually
  // flags it; when it does not, the deposit classifier's own verdict adds it,
  // because both readings latch `depositKnown` and only one of them is right.
  const depositIsChoice = dep?.stated === true && dep.kind === "cash-or-document";
  if (depositIsChoice && !uncertain.some((u) => u.subject === "deposit")) {
    uncertain.push({
      subject: "deposit",
      reading: dep.quote?.slice(0, 200) || "they named more than one deposit they accept",
      question: `Sorry, just so I've got it right - can I leave ${
        dep.amount ? `${dep.amount}${dep.currency ? " " + dep.currency : ""} cash` : "a cash deposit"
      } OR the passport, whichever suits me?`,
      confidence: dep.confidence,
    });
  }

  // W4.6: reported, never decided here. The floor and the persistence live in
  // wa/thread-language, so an outage degrades to "no statement" -> no change.
  const lang = c.languageRequest;
  const languageRequest: LanguageStatement | undefined =
    lang && (lang.prefers === "english" || lang.prefers === "local")
      ? {
          prefers: lang.prefers,
          ...(lang.quote ? { quote: lang.quote.slice(0, 200) } : {}),
          confidence: lang.confidence,
        }
      : undefined;

  return {
    stance: c.stance,
    stanceQuote: c.stanceQuote ?? undefined,
    stanceReason: c.stanceReason ?? undefined,
    ...(languageRequest ? { languageRequest } : {}),
    deflected: sure && !stockOut && c.stance === "deflecting",
    declined: sure && !stockOut && c.stance === "declining",
    // A2 - FIRMNESS, AND ONLY FROM AN EXPLICIT REFUSAL. Undefined when the
    // provider omitted the key (an older model, a shorter shape) rather than
    // false, so `mergeComprehension` can tell "the model looked and saw no
    // refusal" from "nobody looked" - only the first may ever end bargaining.
    ...(c.firmness
      ? {
          firm:
            c.firmness.refusesLower === true &&
            c.firmness.confidence >= FIRMNESS_CONFIDENCE_FLOOR,
          ...(c.firmness.quote ? { firmQuote: c.firmness.quote.slice(0, 200) } : {}),
        }
      : {}),
    ...(depositRead ? { deposit: depositRead } : {}),
    // A5 - the handover MODE and its PRICE, two facts. Dropped below the terms
    // floor: an unsure read leaves both questions askable, which costs a message
    // and never costs the traveller an unasked-about delivery fee.
    ...(c.handover && c.handover.confidence >= TERMS_CONFIDENCE_FLOOR
      ? {
          handover: {
            mode: c.handover.mode,
            costStated: c.handover.costStated === true,
            ...(typeof c.handover.cost === "number" ? { cost: c.handover.cost } : {}),
            ...(c.handover.currency ? { currency: c.handover.currency } : {}),
            confidence: c.handover.confidence,
          },
        }
      : {}),
    availability: avail.value?.state,
    restockHint: avail.value?.backWhen ?? undefined,
    freeMeansNoCost: avail.value?.freeMeansNoCost ?? undefined,
    uncertain: uncertain.slice(0, 3),
    degraded: false,
    provider: comp.provider,
    ms,
  };
}

/**
 * DID THE SHOP ANSWER THE QUESTION WE ARE WAITING ON?
 *
 * The second half of the owner's rule - "then wait for the shop answer" - is a
 * state machine, and a state machine needs an exit. The exit is a JUDGEMENT
 * about what their reply meant, so it goes to the model (semantic/classifiers
 * readConfirmAnswer, zod-validated) and never to a keyword test: a shop settles
 * "passport or 4000 cash?" with "yes both ok", "up to you", "cash better", or a
 * correction, and no phrase list has ever survived contact with that.
 *
 * Deterministic code keeps everything around it: which doubt we are waiting on,
 * how many turns the wait has left, and what becomes legal while it lasts
 * (spte/digest advanceConfirmState + spte/policy).
 *
 * DEGRADES TO PATIENCE. No provider, a timeout, a shape it could not satisfy -
 * all return null, which means "not answered yet", which means the thread keeps
 * waiting until the turn bound releases it. An outage can delay an answer; it
 * can never manufacture one.
 */
export interface ConfirmResolution {
  subject: ConfirmSubject;
  /** The shop settled it - the model's verdict, above the floor. */
  answered: boolean;
  /** What they settled it as, in their own words. */
  answer?: string;
  confidence: number;
  /** No provider answered - keep waiting, change nothing. */
  degraded: boolean;
}

export async function readConfirmResolution(input: {
  pending: PendingConfirm;
  /** The shop's message, English gloss preferred (same rule as the pass above). */
  text: string;
  context?: string;
  budgetMs?: number;
}): Promise<ConfirmResolution | null> {
  const text = (input.text ?? "").trim();
  const question = (input.pending.question ?? "").trim();
  if (!text || !question) return null;
  const { readConfirmAnswer } = await import("../semantic/classifiers");
  const budget = input.budgetMs ?? Math.floor(COMPREHENSION_BUDGET_MS * 0.6);
  const out = await withCeiling(
    readConfirmAnswer(question, text, input.context, { budgetMs: budget, once: true }).catch(
      () => null
    ),
    budget,
    null
  );
  const v = out?.value;
  if (!v) {
    return {
      subject: input.pending.subject,
      answered: false,
      confidence: 0,
      degraded: out?.degraded !== false,
    };
  }
  return {
    subject: input.pending.subject,
    // ALL THREE CONDITIONS. A reply that engaged with the question and left us
    // no wiser (`stillUnclear`) is not an answer - it is the same ambiguity
    // again, and ending the wait on it would re-latch the reading we distrust.
    answered: v.answered === true && v.stillUnclear !== true && v.confidence >= CONFIRM_ANSWER_FLOOR,
    ...(v.answer ? { answer: v.answer.slice(0, 200) } : {}),
    confidence: v.confidence,
    degraded: false,
  };
}
