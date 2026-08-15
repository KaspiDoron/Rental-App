// THE THREAD LEDGER: what is KNOWN, what we have ASKED, and what is still OWED.
//
// Derived fresh every turn from the messages the engine already loads - the same
// discipline as spte/thread-facts ("the conversation is the state"), so there is
// nothing to persist and nothing that can go stale.
//
// Two reports come straight out of the two halves:
//
//   ASKED. The agent sent "could you share your best price per day for the 4
//   days?" and then sent it again. Nothing in the system recorded that the
//   question had already been put, so asking a second time was perfectly legal
//   and the prompt was the only thing discouraging it. A prompt is not a
//   constraint. With `asked`, a fact-question whose answer is already
//   outstanding is simply NOT IN THE LEGAL MOVE SET - and the honest move
//   becomes waiting, which is what a person would do.
//
//   OWED. Threads went quiet without ever establishing the deposit or how the
//   traveller actually collects the vehicle. Silence was legal because nothing
//   was owed: there was no notion of an obligation at all. `owed` makes the
//   missing facts first-class, so a thread cannot fall silent while something we
//   have not even asked about is still missing.

import {
  claimsAcross,
  claimsIn,
  settled,
  type Claim,
  type ClaimSubject,
  type ForceHint,
} from "./claims";

/** Subjects a thread must not close without. The traveller cannot collect a
 *  vehicle they do not know how to collect, or budget for a deposit nobody
 *  named. */
export const REQUIRED_SUBJECTS: ClaimSubject[] = ["deposit", "handover"];

/**
 * AN OBLIGATION IS NOT DUE UNTIL ITS PREREQUISITE IS SETTLED.
 *
 * Obligations were unordered, and that produced this on a live Chiang Mai
 * thread, before the shop had named any price at all:
 *
 *   "thanks! We're finalizing our pick between a few shops today - could you
 *    let me know your deposit? Cash amount or passport?"
 *
 * Nothing was wrong with the ledger: deposit was genuinely owed and genuinely
 * unasked. What was missing is that a deposit is a term OF a price. Asking for
 * it first spends the thread's one cheap question on the wrong thing, tells the
 * shop we are further along than we are, and throws away the only real leverage
 * we have - that we have not committed yet.
 *
 * So each required subject names what must be settled before it comes due. This
 * is a fact about what the words MEAN, not a rule about shop wording, and it
 * keeps the ordering in one place instead of scattered across move guards.
 */
export const OBLIGATION_AFTER: Partial<Record<ClaimSubject, ClaimSubject>> = {
  deposit: "price",
  handover: "price",
};

export interface ThreadLedger {
  /** Every claim either side made, chronological within each side. */
  claims: Claim[];
  /** Subjects the SHOP has settled, either way. */
  known: ClaimSubject[];
  /** Subjects WE have asked about and that are still unanswered. */
  outstanding: ClaimSubject[];
  /** Required subjects still missing - the thread owes these before it closes. */
  owed: ClaimSubject[];
  /**
   * Subjects the SHOP asked US about. A question is an obligation on us, and it
   * used to be filed as an answer: "do you want delivery or pickup?" marked
   * handover KNOWN, so the engine believed the shop had explained the handover
   * when it had in fact asked us to explain it.
   *
   * OPTIONAL only so an in-tree literal (spte/policy.ts's empty ledger) keeps
   * compiling through the migration. `buildLedger` always sets it; make it
   * required once every hand-built ThreadLedger carries it.
   */
  shopAsked?: ClaimSubject[];
  /**
   * THE THIRD STATE: ANSWERED, BUT WE ARE NOT SURE WHAT THE ANSWER WAS.
   *
   * `known` and `outstanding` are a two-state book - a subject has been settled
   * by the shop or it has not - and that shape is exactly why a misread could
   * never be repaired. "We have deposit passport or money4000" settles the
   * deposit subject by every test this file applies, so `depositKnown` latched,
   * the deposit probe retired forever, and whichever of the two readings the
   * extractor happened to take became permanent. There was no way to say "they
   * told us, and we are not confident we understood".
   *
   * Populated from the comprehension pass (spte/comprehension.ts), not from the
   * text: only something that has READ the message knows it is ambiguous. A
   * subject in here is NOT known, and a confirming question about it is legal
   * exactly once (bounded by ThreadDigest.confirmAsked).
   */
  ambiguous?: ClaimSubject[];
}

/**
 * Where a subject stands, as one value instead of three boolean lookups.
 *
 *   unasked   - nobody has raised it
 *   asked     - we asked; the shop has not answered since
 *   answered  - the shop settled it, either way
 *   ambiguous - the shop answered and we are not confident what they meant
 *
 * `ambiguous` deliberately outranks `answered`: the whole point is that an
 * answer we cannot trust must not count as one.
 */
export type SubjectState = "unasked" | "asked" | "answered" | "ambiguous";

export function subjectState(ledger: ThreadLedger, subject: ClaimSubject): SubjectState {
  if ((ledger.ambiguous ?? []).includes(subject)) return "ambiguous";
  if (ledger.outstanding.includes(subject)) return "asked";
  if (ledger.known.includes(subject)) return "answered";
  return "unasked";
}

export interface LedgerInput {
  /** Shop messages, chronological. */
  inbound: string[];
  /** Our messages, chronological. */
  outbound: string[];
  /** The message that just arrived (deduped against `inbound`). */
  currentInbound?: string;
  /**
   * A better-informed verdict on whether each inbound clause tells or asks -
   * the inbound act classifier knows a rhetorical "how can we help you?" from a
   * real question. Omitted, the claim layer decides from the clause itself.
   */
  force?: ForceHint;
  /**
   * Subjects the comprehension pass reported it is NOT confident it read. They
   * are struck from `known` (an answer nobody understood is not an answer) and
   * surfaced as the ledger's third state. Absent -> today's two-state book.
   */
  ambiguous?: ClaimSubject[];
}

/**
 * Did this message of OURS ask about a subject? A question is a claim-shaped
 * act: it names a subject and ends in a question, or uses an asking verb. Kept
 * deliberately simple - the point is not to classify English perfectly, it is to
 * have a RECORD that a subject was raised, which the system had none of.
 */
const ASKING =
  /\?|\b(could you|can you|what'?s|what is|how much|do you|would you|let me know|please (tell|share|confirm)|any chance)\b/i;

export function askedSubjects(message: string): ClaimSubject[] {
  if (!ASKING.test(message)) return [];
  // A question about X is a claim-shaped mention of X in an asking message.
  return [...new Set(claimsIn(message, "us", 0).map((c) => c.subject))];
}

export function buildLedger(input: LedgerInput): ThreadLedger {
  const inbound = [...input.inbound];
  const cur = (input.currentInbound ?? "").trim();
  if (cur && inbound[inbound.length - 1]?.trim() !== cur) inbound.push(cur);

  const shopClaims = claimsAcross(inbound, "shop", { force: input.force });
  const ourClaims = claimsAcross(input.outbound, "us");
  const claims = [...shopClaims, ...ourClaims];

  // TOLD and ASKED are different ledgers. Only what the shop ASSERTED can make a
  // subject known; what it ASKED goes on the other side of the book, where it
  // reads as an obligation on us instead of a fact about the deal.
  const shopTold = shopClaims.filter((c) => c.force !== "ask");
  // ...AND AN ANSWER WE DID NOT UNDERSTAND IS NOT AN ANSWER. A subject the
  // comprehension pass flagged as ambiguous is struck from `known`, which is
  // what stops depositKnown latching on a reading nobody trusts.
  const ambiguous = [...new Set(input.ambiguous ?? [])];
  const known = [...new Set(shopTold.map((c) => c.subject))].filter(
    (s) => !ambiguous.includes(s)
  );
  const shopAsked = [...new Set(shopClaims.filter((c) => c.force === "ask").map((c) => c.subject))];

  // OUTSTANDING = we asked about it AFTER the shop's last word on it. Comparing
  // positions across the two lists is not exact interleaving, but it is the
  // right question in the common shape: our newest ask versus the shop's newest
  // answer. An ask with no answer at all is outstanding by definition.
  const lastShopAt = new Map<ClaimSubject, number>();
  for (const c of shopTold) {
    const prev = lastShopAt.get(c.subject);
    if (prev === undefined || c.at > prev) lastShopAt.set(c.subject, c.at);
  }
  const lastAskAt = new Map<ClaimSubject, number>();
  input.outbound.forEach((m, i) => {
    for (const s of askedSubjects(m)) lastAskAt.set(s, i);
  });
  const outstanding: ClaimSubject[] = [];
  for (const [subject, askIndex] of lastAskAt) {
    const answered = lastShopAt.get(subject);
    // The shop has replied at least as recently as our ask -> answered.
    if (answered !== undefined && answered >= askIndex) continue;
    outstanding.push(subject);
  }

  // Owed = required, still unsettled, AND whose prerequisite the shop has
  // already settled. A deposit is a term of a price; until there is a price it
  // is not yet this thread's turn to ask.
  const owed = REQUIRED_SUBJECTS.filter((s) => {
    if (ambiguous.includes(s)) return true; // told, not understood - still owed
    if (settled(shopClaims, s)) return false;
    const after = OBLIGATION_AFTER[s];
    return !after || settled(shopClaims, after);
  });

  return { claims, known, outstanding, owed, shopAsked, ambiguous };
}

/** Would asking about this subject repeat a question already outstanding? */
export function alreadyAsked(ledger: ThreadLedger, subject: ClaimSubject): boolean {
  return ledger.outstanding.includes(subject);
}

/** Required facts we have NOT asked about yet - the thread genuinely owes these
 *  a question before it is allowed to fall silent. */
export function unaskedObligations(ledger: ThreadLedger): ClaimSubject[] {
  return ledger.owed.filter((s) => !ledger.outstanding.includes(s));
}

/**
 * IS THERE A VEHICLE TO RENT, ACCORDING TO THE SHOP?
 *
 * "Now I don't have bike." matched nothing anywhere in the system: the card
 * sat waiting for a price that was never coming, the map kept the pin live,
 * and the agent kept haggling over a scooter that did not exist. Out of stock
 * is a normal, temporary, extremely common state - not a decline, not a
 * failure, and certainly not silence.
 *
 * Read from the shop's LAST availability claim, so a restock ("we have one
 * now") un-sticks the state by itself, exactly like every other fact here.
 * `restockHint` is the shop's own timing word when it gave one.
 */
export function stockState(ledger: ThreadLedger | undefined): {
  state: "in-stock" | "out-of-stock" | "unknown";
  restockHint?: string;
} {
  const claims = (ledger?.claims ?? []).filter(
    (c) => c.subject === "availability" && c.actor === "shop" && c.force !== "ask"
  );
  if (!claims.length) return { state: "unknown" };
  // LATEST WINS, AND A DENIAL WINS A TIE.
  //
  // `b.at >= a.at` alone let array order decide when one message produced two
  // availability claims - and one message routinely does: "no scooters today,
  // bikes available tomorrow" is two claims stamped identically. Deciding that
  // by whichever the scanner happened to emit last is a coin flip on the most
  // consequential fact in the thread, and the wrong side of it keeps an agent
  // haggling over a vehicle the shop just said it does not have.
  //
  // At equal timestamps the denial is the safe read: believing a shop has
  // stock it lacks wastes the traveller's search; believing it lacks stock it
  // has costs one extra question.
  const latest = claims.reduce((a, b) => {
    if (b.at > a.at) return b;
    if (b.at < a.at) return a;
    return a.polarity === "denied" ? a : b;
  });
  const restockHint = latest.details.includes("restock")
    ? // The evidence carries the shop's own words; the detail only says one
      // was present. Showing their sentence beats inventing a paraphrase.
      latest.evidence
    : undefined;
  return {
    state: latest.polarity === "denied" ? "out-of-stock" : "in-stock",
    restockHint,
  };
}
