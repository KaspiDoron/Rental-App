// TYPED CLAIMS: what was said, about what, by whom - and whether it was
// AFFIRMED or DENIED.
//
// Three separate reports came from the same missing concept. The app read
// conversations as flat text and matched cues against it, with no notion of what
// the cue was a claim ABOUT, who made it, or whether it was being asserted or
// denied. So:
//
//   - "no deposit, just your passport at pickup" - the best terms in the whole
//     thread - was filed as a PASSPORT DEPOSIT (the deposit branch fell through
//     to an else that saw the word "passport"), and simultaneously flagged as a
//     safety risk, because the document-harvesting rule looked for "passport"
//     near "pic" and found it inside "pickup".
//   - the agent asked "your best price per day for the 4 days?" and then asked
//     it again, because nothing recorded that the question had already been put.
//   - threads went quiet without ever establishing the deposit or how the
//     traveller collects the vehicle, because nothing was OWED.
//
// A claim has a subject, a polarity, an actor and a position in the thread. With
// that, "no deposit" and "deposit required" can never collapse into each other,
// a question is a fact about the thread rather than a hope in a prompt, and the
// chips, filters, risk screen and legal-move set all read the same structure.
//
// FOUR MORE DIMENSIONS, each one a class of bug that could not be expressed
// without it:
//
//   MULTIPLE DETAILS. A claim used to carry ONE detail - the first entry in the
//   subject's list that matched anywhere in the clause. "Deposit is 3000 cash
//   and a passport copy" therefore became a cash deposit and the passport was
//   destroyed at parse time, in the one layer the rest of the app treats as
//   ground truth. A requirement with two components needs two components.
//
//   FORM. "We keep your passport" and "we take a passport photo at the shop"
//   are the same word about the same subject and are not remotely the same
//   deal: one surrenders the traveller's only identity document for the length
//   of the rental, the other is a photocopy on a counter. Nothing in the model
//   could tell them apart, so nothing downstream could either.
//
//   COMBINATOR. "Passport or 2000 baht" is a choice. "Passport and 2000 baht"
//   is a bill. With no connector in the value, every surface had to guess, and
//   the shop card guessed "or" for everything - telling the traveller they get
//   to choose when in fact they must supply both.
//
//   TIMING and TARGET. What separates a shop describing its counter procedure
//   from a document-harvesting scam is not the words: both say "passport" and
//   "copy". It is WHEN (at the handover, or now before anything exists) and OF
//   WHOM (something the shop does, or something the traveller is told to do).
//   Without those axes the safety screen was matching tokens, which is why it
//   scored a shop's standard terms as a scam and a textbook scam as harmless.
//
// FORCE is the fifth. "Do you want delivery or pickup?" is a shop QUESTION, and
// it used to register as the shop having TOLD us how handover works - so the
// ledger marked the subject known, the engine stopped asking, and the thread
// closed on a fact nobody had ever stated. A claim now records whether its
// clause asserts or asks. Callers that know better (the inbound act classifier)
// can override per clause; the default is deliberately biased towards "ask",
// because a claim wrongly read as a question only costs one more question,
// while a question wrongly read as a claim invents a fact.
//
// PURE by construction: no clock, no database, no LLM. The conversation is the
// state, so claims are re-derived every turn and nothing can go stale.

export type ClaimSubject =
  | "price"
  | "deposit"
  | "handover"
  | "availability"
  | "licence"
  | "insurance"
  | "helmet";

export type Polarity = "affirmed" | "denied";
export type Actor = "shop" | "us";

/**
 * Illocutionary force, reduced to the one distinction this layer can make
 * honestly from the clause alone: is it TELLING us something, or ASKING us?
 * Richer taxonomies (offer/greet/refuse) belong to the inbound act classifier,
 * which can pass its verdict in through `ClaimOptions.force`.
 */
export type ClaimForce = "assert" | "ask";

/** Whether a document is SURRENDERED or merely COPIED. */
export type DetailForm = "original" | "copy";

/** How the details of one claim combine. `single` = exactly one detail. */
export type DetailCombinator = "single" | "and" | "or";

/** WHEN the claim's requirement falls due. */
export type ClaimTiming = "at-handover" | "up-front" | "unstated";

/** WHO has to do something about it. */
export type ClaimTarget = "traveller" | "shop" | "unstated";

/** One component of a claim - a kind, and for documents, the form it takes. */
export interface ClaimDetail {
  /** "cash" | "passport" | "id" | "licence" | "delivery" | "pickup" ... */
  detail: string;
  /** Documents only, and only when the clause actually said. */
  form?: DetailForm;
  /** Where in the clause it was found. Details are ordered by this, and the
   *  combinator is read from the words BETWEEN adjacent details. */
  index: number;
}

export interface Claim {
  subject: ClaimSubject;
  polarity: Polarity;
  actor: Actor;
  /** Position in the actor's own message list - the pure layer's "when". */
  at: number;
  /**
   * The PRIMARY detail - `details[0]`. Kept because it is the field the first
   * generation of consumers reads; new code should read `details` or `parts`,
   * since a composite requirement has more than one. Migration: once no call
   * site reads `.detail`, drop it.
   */
  detail?: string;
  /** Every kind this claim names, in the order the clause named them. */
  details: string[];
  /** The same, with each document's form and position. */
  parts: ClaimDetail[];
  /** Whether the details are alternatives or a list of requirements. */
  combinator: DetailCombinator;
  /** At the handover, or before anything exists. */
  timing: ClaimTiming;
  /** Whose action the claim describes. */
  target: ClaimTarget;
  /** Told, or asked. */
  force: ClaimForce;
  /** The words that established it, so a chip or a rail can explain itself. */
  evidence: string;
  /** Which clause of the message it came from - so a benign claim in one clause
   *  can never excuse or condemn a different clause. */
  clauseIndex: number;
}

interface DetailSpec {
  detail: string;
  rx: RegExp;
  /** Documents carry a FORM; money and logistics do not. */
  document?: boolean;
}

interface SubjectSpec {
  subject: ClaimSubject;
  /** Cue words that mean this subject is being talked about at all. */
  cue: RegExp;
  /** Optional kinds, matched inside the same clause as the cue. */
  details?: DetailSpec[];
}

// One table, extended by adding a row - not by adding a branch somewhere.
const SUBJECTS: SubjectSpec[] = [
  {
    subject: "deposit",
    // PLURALS ARE LOAD-BEARING. `\b` cannot fall between "deposit" and its own
    // "s", so the singular-only cue produced ZERO claims for a shop that wrote
    // "Deposits for motorbikes (2 options)". That silence is what let the
    // document-demand rule flag a plain statement of terms as a scam: the
    // terms-exemption in inbound-risk asks this table whether the message is
    // about a deposit, and this table said no.
    cue: /\b(deposits?|down ?payments?|collaterals?|security bonds?|as a bond)\b/i,
    // A claim carries EVERY kind it names (`details`/`parts`, ordered by where
    // they appear in the clause), so this list is a vocabulary and not a
    // priority order. That is what lets "Copy Passport + 3000 THB" stay one
    // requirement with two components; the single-valued `detail` is only the
    // back-compat view of the first of them. `document: true` opens the
    // original-vs-copy axis - the distinction between surrendering your only
    // travel document and leaving a photocopy on a counter.
    details: [
      { detail: "cash", rx: /\b(cash|\d[\d,.]{2,}|money)\b/i },
      { detail: "passport", rx: /\bpassports?\b/i, document: true },
      { detail: "id", rx: /\b(id cards?|identity cards?|ktp)\b/i, document: true },
      { detail: "licence", rx: /\b(driver'?s? )?licen[cs]e\b/i, document: true },
    ],
  },
  {
    // What the traveller must LEAVE or SHOW, separate from money held. A shop
    // that keeps no cash but holds a passport is making two different claims.
    //
    // ARTICLES ARE OPTIONAL. "Come to shop with passport copy" and "we take
    // passport photo at shop" are how these shops actually write - the article
    // is the first thing SE-Asian shop English drops. Requiring it meant the
    // handover claim was simply not seen, and every layer that asks "is this
    // the shop describing its counter procedure?" got "no" for the most common
    // phrasing there is.
    subject: "handover",
    cue: /\b(deliver(y|ed|s)?|drop( it)? off|bring it|pick ?up|pick it up|collect|come (to|by|in ?to) ((the|our|my|your) )?(shop|store|office|counter)|(at|in) ((the|our|my) )?(shop|store|office|counter)|in ?store|meet you)\b/i,
    details: [
      { detail: "delivery", rx: /\b(deliver(y|ed|s)?|drop( it)? off|bring it|meet you)\b/i },
      {
        detail: "pickup",
        rx: /\b(pick ?up|pick it up|collect|come (to|by|in ?to) ((the|our|my|your) )?(shop|store|office|counter)|(at|in) ((the|our|my) )?(shop|store|office|counter)|in ?store)\b/i,
      },
    ],
  },
  {
    subject: "availability",
    cue: /\b(available|availability|in stock|we have|got one|free (today|tomorrow))\b/i,
  },
  {
    subject: "licence",
    cue: /\b(licen[cs]e|idp|international driving permit)\b/i,
    details: [{ detail: "licence", rx: /\b(licen[cs]e|idp)\b/i, document: true }],
  },
  {
    subject: "insurance",
    cue: /\b(insurance|insured|coverage|covered)\b/i,
  },
  {
    subject: "helmet",
    cue: /\bhelmets?\b/i,
  },
  {
    subject: "price",
    cue: /\b(price|rate|per day|\/day|cost|charge)\b/i,
  },
];

/**
 * Words that flip a claim, plus the ways a language buries one. General on
 * purpose: this is the mechanism, not a list of the phrasings we happen to have
 * seen. "we don't take a deposit", "no deposit needed", "deposit free" and
 * "without deposit" are all the same claim, and none of them means the shop
 * wants a deposit.
 */
const NEGATORS =
  /\b(no|not|none|never|without|don'?t|doesn'?t|do not|isn'?t|is not|aren'?t|won'?t|cannot|can'?t|free of|zero|nothing|skip|waive[ds]?)\b/i;

/**
 * A PHOTOCOPY, in every spelling a counter uses. "photocopy" is listed in full
 * because `\bcopy\b` cannot match inside it - both neighbours are word
 * characters, so the boundary fails - and "photocopy" is the standard word on
 * Thai and Indonesian rental counters. `pics?` keeps its boundaries: unanchored,
 * `pic` matches inside "pickup", which is the original false-flag bug.
 */
const COPY_RX =
  /\b(photo-?copies|photo-?copy|photocopy|photocopies|xerox|soft-?copies|soft-?copy|scans?|scanned|copies|copy|photos?|foto|pictures?|pics?|images?)\b/i;

/**
 * The shop taking custody of the thing itself. "We keep your passport" is the
 * claim a traveller most needs to see coming, and it is stated with a verb, not
 * with the word "original".
 */
const SURRENDER_RX =
  /\b(keeps?|keeping|holds?|holding|leaves?|leaving|surrender|deposit your|take your|takes your|until you (return|bring|come))\b/i;

/** The handover: this happens when the traveller and the vehicle are together. */
const AT_HANDOVER_RX =
  /\b(at|on|during)\s+(the\s+)?(pick\s?-?up|pickup|collection|handover|counter|shop|store|office)\b|\bwhen\s+you\s+(come|arrive|collect|pick|rent|get|take)\b|\bon\s+arrival\b|\bat\s+the\s+time\s+of\b|\bin\s+person\b|\bat\s+pick\s?-?up\b/i;

/** Before anything exists - the timing that turns a normal ask into pressure. */
const UP_FRONT_RX =
  /\b(first|before|in advance|up\s?front|beforehand|now|right away|immediately|straight away|to\s+(confirm|reserve|hold|book|secure))\b/i;

/** "we take / we keep / our shop needs" - the shop describing what IT does. */
const SHOP_SUBJECT_RX =
  /\b(we|our shop|the shop|our office|office)\s+(will\s+|can\s+|always\s+)?(take|takes|keep|keeps|hold|holds|need|needs|require|requires|want|wants|ask|asks|charge|charges|collect|collects|make|makes|scan|scans|accept|accepts|deliver|delivers|bring|brings|come|comes|give|gives)\b/i;

/** Something the TRAVELLER is being told to do. */
const TRAVELLER_ACT_RX =
  /\b(send|sends|share|shares|forward|upload|post|e-?mail|mail|dm|text|whats-?app|message|give|bring|show|leave|hand|present|prepare|provide|drop off|come (to|by|with)|you (must|need to|can|should|have to)|please)\b/i;

/** Connectors between two details of the same claim. */
const AND_RX = /\b(and|plus|also|as well as|together with|both|along with)\b|[&+]/i;
const OR_RX = /\b(or|either|alternatively|instead of|otherwise)\b/i;

/**
 * An interrogative lead, for clauses that ask without a question mark - which is
 * most of them in chat. Deliberately biased: a statement misread as a question
 * costs one redundant question, while a question misread as a statement puts a
 * fact in the ledger that nobody ever stated.
 */
const INTERROGATIVE_LEAD_RX =
  /^\s*(do|does|did|are|is|was|were|can|could|would|will|shall|should|have|has|may|how|what|when|where|which|who|why|any)\b/i;

/**
 * Sentence boundaries: a negation never reaches past one, and neither does a
 * document demand. Terminators are KEPT on the clause, because "?" is the single
 * strongest signal of force and splitting it off destroys it. Exported so the
 * inbound act classifier splits text exactly the way claims do - two splitters
 * that disagree about where a sentence ends is how a guard in one module ends up
 * excusing a clause in another.
 */
export function clausesOf(text: string): string[] {
  const out: string[] = [];
  const rx = /[^.!?;\n]+[.!?;]*/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(String(text ?? "")))) {
    const clause = m[0].trim();
    if (clause) out.push(clause);
  }
  return out;
}

/**
 * A negator scopes to the NEAREST subject that follows it, and no further.
 *
 * That single rule is what separates "no deposit, just your passport at pickup"
 * into a DENIED deposit and an AFFIRMED pickup - instead of letting one "no" at
 * the front of the sentence swallow everything after it, or (as the code this
 * replaces did) letting the passport fall through an `else` and become a
 * passport deposit. It is grammar-free on purpose: it needs no comma rules and
 * no list of the phrasings we happen to have seen.
 */
function negatedCues(clause: string, cueIndexes: number[]): Set<number> {
  const negated = new Set<number>();
  const rx = new RegExp(NEGATORS.source, "gi");
  const sorted = [...cueIndexes].sort((a, b) => a - b);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(clause))) {
    const nearest = sorted.find((i) => i > m!.index);
    if (nearest !== undefined) negated.add(nearest);
  }
  return negated;
}

/**
 * Which form a document takes, read from the words that belong to THAT
 * document. The window stops at the neighbouring detail and at the nearest
 * comma, so "we keep your passport, send a copy of the licence" keeps the
 * passport an original and makes only the licence a copy - a form marker
 * anywhere in the clause would have made both of them copies.
 */
function formOf(clause: string, lo: number, hi: number, index: number, length: number): DetailForm | undefined {
  const comma = clause.lastIndexOf(",", index);
  const nextComma = clause.indexOf(",", index + length);
  const from = Math.max(lo, comma >= 0 ? comma + 1 : 0, index - 32);
  const to = Math.min(hi, nextComma >= 0 ? nextComma : clause.length, index + length + 32);
  if (COPY_RX.test(clause.slice(from, to))) return "copy";
  if (SURRENDER_RX.test(clause.slice(from, to))) return "original";
  // The surrender verb often leads the whole clause ("we keep your passport and
  // 2000 baht"), so fall back to it once nothing nearer has decided.
  if (SURRENDER_RX.test(clause)) return "original";
  return undefined;
}

/** Every detail this clause names for one subject, in the order it named them. */
function partsOf(clause: string, spec: SubjectSpec): ClaimDetail[] {
  const found: Array<{ detail: string; index: number; length: number; document?: boolean }> = [];
  for (const d of spec.details ?? []) {
    const m = new RegExp(d.rx.source, "i").exec(clause);
    if (m) found.push({ detail: d.detail, index: m.index, length: m[0].length, document: d.document });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((f, i) => ({
    detail: f.detail,
    index: f.index,
    form: f.document
      ? formOf(
          clause,
          i > 0 ? found[i - 1].index + found[i - 1].length : 0,
          i + 1 < found.length ? found[i + 1].index : clause.length,
          f.index,
          f.length
        )
      : undefined,
  }));
}

/**
 * AND or OR, read from the words BETWEEN adjacent details. Two details with no
 * connector at all ("passport copy, 3000 baht") read as a list, not a choice -
 * the conservative direction, since telling a traveller they may choose when
 * they may not is the error that costs them money at the counter.
 */
function combinatorOf(clause: string, parts: ClaimDetail[]): DetailCombinator {
  if (parts.length < 2) return "single";
  let sawOr = false;
  for (let i = 1; i < parts.length; i++) {
    const gap = clause.slice(parts[i - 1].index, parts[i].index);
    if (AND_RX.test(gap)) return "and";
    if (OR_RX.test(gap)) sawOr = true;
  }
  return sawOr ? "or" : "and";
}

/** At the handover or up front - whichever the clause says FIRST. */
function timingOf(clause: string): ClaimTiming {
  const handover = clause.search(new RegExp(AT_HANDOVER_RX.source, "i"));
  const upFront = clause.search(new RegExp(UP_FRONT_RX.source, "i"));
  if (handover < 0 && upFront < 0) return "unstated";
  if (handover < 0) return "up-front";
  if (upFront < 0) return "at-handover";
  // A tie or a handover marker first reads as the handover: "before you come to
  // shop, prepare passport copy" is still counter procedure.
  return upFront < handover ? "up-front" : "at-handover";
}

/** Whose action is being described - again, whichever the clause says first. */
function targetOf(clause: string): ClaimTarget {
  const shop = clause.search(new RegExp(SHOP_SUBJECT_RX.source, "i"));
  const traveller = clause.search(new RegExp(TRAVELLER_ACT_RX.source, "i"));
  if (shop < 0 && traveller < 0) return "unstated";
  if (shop < 0) return "traveller";
  if (traveller < 0) return "shop";
  return shop < traveller ? "shop" : "traveller";
}

/** Told or asked, when nobody better-informed has said. */
function forceOf(clause: string): ClaimForce {
  if (clause.includes("?")) return "ask";
  return INTERROGATIVE_LEAD_RX.test(clause) ? "ask" : "assert";
}

/**
 * A caller that classified the message properly (the inbound act layer knows a
 * rhetorical "how can we help you?" from a real question) can hand its verdict
 * down per clause, so this module never has to grow a second, weaker classifier.
 */
export type ForceHint =
  | ClaimForce
  | ((clause: string, clauseIndex: number, at: number) => ClaimForce | undefined);

export interface ClaimOptions {
  force?: ForceHint;
}

function resolveForce(
  hint: ForceHint | undefined,
  clause: string,
  clauseIndex: number,
  at: number
): ClaimForce {
  if (typeof hint === "string") return hint;
  if (typeof hint === "function") {
    const given = hint(clause, clauseIndex, at);
    if (given) return given;
  }
  return forceOf(clause);
}

/** Every claim one message makes. */
export function claimsIn(
  text: string,
  actor: Actor,
  at: number,
  opts?: ClaimOptions
): Claim[] {
  const out: Claim[] = [];
  const clauses = clausesOf(text);
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
    const clause = clauses[clauseIndex];
    // Every subject mentioned in this clause, with where it was mentioned.
    const hits: Array<{ spec: SubjectSpec; index: number; length: number }> = [];
    for (const spec of SUBJECTS) {
      const m = new RegExp(spec.cue.source, "i").exec(clause);
      if (m) hits.push({ spec, index: m.index, length: m[0].length });
    }
    if (!hits.length) continue;
    const negated = negatedCues(
      clause,
      hits.map((h) => h.index)
    );
    const force = resolveForce(opts?.force, clause, clauseIndex, at);
    const timing = timingOf(clause);
    const target = targetOf(clause);
    for (const hit of hits) {
      // "deposit free" / "deposit only" - the denial trailing its subject.
      const trailing = clause.slice(hit.index + hit.length, hit.index + hit.length + 14);
      const isDenied = negated.has(hit.index) || /^\s*free\b/i.test(trailing);
      const parts = partsOf(clause, hit.spec);
      out.push({
        subject: hit.spec.subject,
        polarity: isDenied ? "denied" : "affirmed",
        actor,
        at,
        detail: parts[0]?.detail,
        details: parts.map((p) => p.detail),
        parts,
        combinator: combinatorOf(clause, parts),
        timing,
        target,
        force,
        evidence: clause.slice(0, 160),
        clauseIndex,
      });
    }
  }
  return out;
}

/** Every claim in a whole side of the conversation, chronological. */
export function claimsAcross(messages: string[], actor: Actor, opts?: ClaimOptions): Claim[] {
  return messages.flatMap((m, i) => claimsIn(m, actor, i, opts));
}

/** The newest claim about a subject, or undefined. */
export function latestClaim(claims: Claim[], subject: ClaimSubject): Claim | undefined {
  let best: Claim | undefined;
  for (const c of claims) {
    if (c.subject !== subject) continue;
    if (!best || c.at >= best.at) best = c;
  }
  return best;
}

/** Does this claim name a document, and in what form? */
export function documentForm(claim: Claim): DetailForm | undefined {
  return claim.parts.find((p) => p.form)?.form;
}

/** Does this claim require the traveller to give up the document itself? */
export function surrendersDocument(claim: Claim): boolean {
  return claim.polarity === "affirmed" && claim.parts.some((p) => p.form === "original");
}

/**
 * Has this subject been SETTLED by the shop - said either way, so we know?
 * "no deposit" settles the deposit question exactly as firmly as "3000 baht".
 * That equivalence is the whole point: the old boolean only counted the second
 * kind, so a shop with the friendliest possible terms read as "deposit unknown"
 * and got asked about it forever.
 *
 * A QUESTION settles nothing. "How much deposit can you leave?" mentions the
 * deposit and states none, and counting it was how the engine came to believe
 * the shop had told us things it had only asked about.
 */
export function settled(claims: Claim[], subject: ClaimSubject): boolean {
  return claims.some((c) => c.actor === "shop" && c.subject === subject && c.force !== "ask");
}
