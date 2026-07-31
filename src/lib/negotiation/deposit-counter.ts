// THE PASSPORT-DEPOSIT COUNTER - one polite attempt, never a fight.
//
// Leaving an ORIGINAL passport with a shop is standard practice across
// Southeast Asia, and the risk screen treats it that way (a calm note, not a
// warning). But standard does not mean preferred: most travellers would rather
// leave cash and a photocopy, and many shops will quietly accept that if
// asked nicely. What the field test showed is that the agent never asked -
// and that the ask, when a human made it, worked.
//
// The strategy is deliberately narrow:
//   - it fires ONLY when the shop's stated terms require the original
//     passport with NO cash alternative already on the table;
//   - it is ONE attempt, phrased as a preference, never a refusal;
//   - a decline is accepted gracefully - the deal continues on the shop's
//     terms, and nothing ever asks twice.
//
// PURE: the conversation is the state (ledger claims + our own prior sends),
// and the wording is seeded, not random, so golden replays stay byte-stable.

import type { ThreadLedger } from "../thread/ledger";

/**
 * The shop's deposit terms require surrendering the ORIGINAL passport and
 * offer no cash alternative. A "passport OR 3000 baht" menu already contains
 * the answer we want, so it never triggers the counter; a "copy of passport"
 * requirement costs the traveller nothing and does not either.
 */
export function passportOnlyDeposit(ledger: ThreadLedger | undefined): boolean {
  if (!ledger) return false;
  const depositClaims = ledger.claims.filter(
    (c) => c.subject === "deposit" && c.actor === "shop" && c.polarity === "affirmed"
  );
  if (!depositClaims.length) return false;
  // The shop's LAST word on the deposit is the live terms.
  const latest = depositClaims.reduce((a, b) => (b.at >= a.at ? b : a));
  const wantsOriginal = latest.parts.some(
    (p) => p.detail === "passport" && p.form !== "copy"
  );
  if (!wantsOriginal) return false;
  // Any cash route already offered - in this claim as an alternative, or in
  // any other live deposit statement - means there is nothing to counter.
  const cashOffered =
    (latest.combinator === "or" && latest.details.includes("cash")) ||
    depositClaims.some((c) => c !== latest && c.details.includes("cash"));
  return !cashOffered;
}

/** Have WE already made the cash-deposit counter in this thread? One shot. */
export function counterAlreadyMade(ourTexts: Array<string | undefined | null>): boolean {
  return ourTexts.some((t) => t && /cash\s+deposit/i.test(t));
}

/** Deterministic member of the polite-counter family for this thread. */
export function composePassportCounter(seed: string): string {
  const FAMILY = [
    "Totally fine! One thing - we'd prefer to leave a cash deposit rather than our original passport, as we're not fully comfortable leaving it. Could we do cash plus a photo of the passport instead?",
    "That works for us - though would a cash deposit be possible instead of the original passport? We can leave cash and a photo of our passport. If not, no problem at all!",
    "Sounds good! Quick question - we aren't fully comfortable leaving our original passport. Can we do a cash deposit instead, with a photo of our passport? Happy either way.",
  ];
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return FAMILY[Math.abs(h) % FAMILY.length];
}
