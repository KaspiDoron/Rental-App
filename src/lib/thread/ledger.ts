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
} from "./claims";

/** Subjects a thread must not close without. The traveller cannot collect a
 *  vehicle they do not know how to collect, or budget for a deposit nobody
 *  named. */
export const REQUIRED_SUBJECTS: ClaimSubject[] = ["deposit", "handover"];

export interface ThreadLedger {
  /** Every claim either side made, chronological within each side. */
  claims: Claim[];
  /** Subjects the SHOP has settled, either way. */
  known: ClaimSubject[];
  /** Subjects WE have asked about and that are still unanswered. */
  outstanding: ClaimSubject[];
  /** Required subjects still missing - the thread owes these before it closes. */
  owed: ClaimSubject[];
}

export interface LedgerInput {
  /** Shop messages, chronological. */
  inbound: string[];
  /** Our messages, chronological. */
  outbound: string[];
  /** The message that just arrived (deduped against `inbound`). */
  currentInbound?: string;
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

  const shopClaims = claimsAcross(inbound, "shop");
  const ourClaims = claimsAcross(input.outbound, "us");
  const claims = [...shopClaims, ...ourClaims];

  const known = [...new Set(shopClaims.map((c) => c.subject))];

  // OUTSTANDING = we asked about it AFTER the shop's last word on it. Comparing
  // positions across the two lists is not exact interleaving, but it is the
  // right question in the common shape: our newest ask versus the shop's newest
  // answer. An ask with no answer at all is outstanding by definition.
  const lastShopAt = new Map<ClaimSubject, number>();
  for (const c of shopClaims) {
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

  const owed = REQUIRED_SUBJECTS.filter((s) => !settled(shopClaims, s));

  return { claims, known, outstanding, owed };
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
