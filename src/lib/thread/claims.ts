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

export interface Claim {
  subject: ClaimSubject;
  polarity: Polarity;
  actor: Actor;
  /** Position in the actor's own message list - the pure layer's "when". */
  at: number;
  /** What kind, when the subject has kinds ("cash", "passport", "delivery"...). */
  detail?: string;
  /** The words that established it, so a chip or a rail can explain itself. */
  evidence: string;
}

interface SubjectSpec {
  subject: ClaimSubject;
  /** Cue words that mean this subject is being talked about at all. */
  cue: RegExp;
  /** Optional kinds, matched inside the same clause as the cue. */
  details?: Array<{ detail: string; rx: RegExp }>;
}

// One table, extended by adding a row - not by adding a branch somewhere.
const SUBJECTS: SubjectSpec[] = [
  {
    subject: "deposit",
    cue: /\b(deposit|down ?payment|collateral|security bond|as a bond)\b/i,
    details: [
      { detail: "cash", rx: /\b(cash|\d[\d,.]{2,}|money)\b/i },
      { detail: "passport", rx: /\bpassports?\b/i },
      { detail: "id", rx: /\b(id card|identity card)\b/i },
      { detail: "licence", rx: /\b(driver'?s? )?licen[cs]e\b/i },
    ],
  },
  {
    // What the traveller must LEAVE or SHOW, separate from money held. A shop
    // that keeps no cash but holds a passport is making two different claims.
    subject: "handover",
    cue: /\b(deliver(y|ed)?|drop( it)? off|bring it|pick ?up|pick it up|collect|come to (the|our) shop|at (the|our) shop|in ?store|meet you)\b/i,
    details: [
      { detail: "delivery", rx: /\b(deliver(y|ed)?|drop( it)? off|bring it|meet you)\b/i },
      { detail: "pickup", rx: /\b(pick ?up|pick it up|collect|come to (the|our) shop|at (the|our) shop|in ?store)\b/i },
    ],
  },
  {
    subject: "availability",
    cue: /\b(available|availability|in stock|we have|got one|free (today|tomorrow))\b/i,
  },
  {
    subject: "licence",
    cue: /\b(licen[cs]e|idp|international driving permit)\b/i,
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

/** Sentence boundaries: a negation never reaches past one. */
function clausesOf(text: string): string[] {
  return String(text ?? "")
    .split(/[.!?;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
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

/** Every claim one message makes. */
export function claimsIn(text: string, actor: Actor, at: number): Claim[] {
  const out: Claim[] = [];
  for (const clause of clausesOf(text)) {
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
    for (const hit of hits) {
      // "deposit free" / "deposit only" - the denial trailing its subject.
      const trailing = clause.slice(hit.index + hit.length, hit.index + hit.length + 14);
      const isDenied = negated.has(hit.index) || /^\s*free\b/i.test(trailing);
      out.push({
        subject: hit.spec.subject,
        polarity: isDenied ? "denied" : "affirmed",
        actor,
        at,
        detail: hit.spec.details?.find((d) => d.rx.test(clause))?.detail,
        evidence: clause.slice(0, 160),
      });
    }
  }
  return out;
}

/** Every claim in a whole side of the conversation, chronological. */
export function claimsAcross(messages: string[], actor: Actor): Claim[] {
  return messages.flatMap((m, i) => claimsIn(m, actor, i));
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

/**
 * Has this subject been SETTLED by the shop - said either way, so we know?
 * "no deposit" settles the deposit question exactly as firmly as "3000 baht".
 * That equivalence is the whole point: the old boolean only counted the second
 * kind, so a shop with the friendliest possible terms read as "deposit unknown"
 * and got asked about it forever.
 */
export function settled(claims: Claim[], subject: ClaimSubject): boolean {
  return claims.some((c) => c.actor === "shop" && c.subject === subject);
}
