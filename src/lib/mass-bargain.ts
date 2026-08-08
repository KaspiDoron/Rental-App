import type { Vendor } from "./types";
import { planCapacity } from "./wa/capacity";

// WHICH SHOPS THE MASS RUN ACTUALLY TALKS TO.
//
// Two problems lived in the one `.slice(0, 10)` this replaces.
//
// The cap was a constant. The server has allowed 30 (Pro) and 40 (Ultra) since
// plan-tiered capacity shipped; the client asked for ten regardless, and the
// copy told a paying traveller they had hit "the 10-shop beta limit" - a
// sentence that is false for two of the three plans and reads as the product
// failing rather than the client under-asking.
//
// And the SELECTION was whatever order the list happened to be in. The vendor
// list is sorted by whatever filter the traveller last touched - distance, or
// price, or nothing - so "bargain with the top 10" meant "the first ten rows",
// which on a distance sort is ten shops chosen for being near, including the
// one-star one with four reviews. A mass run spends a real slice of the plan's
// daily contact budget and puts the traveller's own number in front of every
// shop it picks. It should pick the ones worth talking to.

/**
 * The ceiling for ONE mass run.
 *
 * This was 15, which meant the owner's 24-shop day-one target could not even be
 * REQUESTED - the constraint on day-one breadth was ours, not WhatsApp's. 24 is
 * the agreed ceiling: at a reply rate of 0.35 a 24-shop batch settles to roughly
 * 15 open unanswered threads, which is the quantity that actually carries risk,
 * and comfortably under the 30-shop batch earlier rounds argued about.
 *
 * The real pacing governor is the wave schedule (5-8 shops per ~20 minutes),
 * not this number. This only stops a run being LARGER than a day's budget.
 */
export const MASS_BARGAIN_MAX = 24;

/** How many shops one run may contact for this plan. */
export function massBargainCap(plan?: string | null): number {
  return Math.min(MASS_BARGAIN_MAX, planCapacity(plan).newContacts);
}

/** A shop is eligible when we have not already opened a conversation with it. */
export function isMassEligible(v: Vendor): boolean {
  if (v.offer) return false; // already quoting - the thread is live
  if (!v.whatsapp && !v.placeId) return false; // nothing to message
  return v.stage !== "rfq-sent" && v.stage !== "awaiting-response" && v.stage !== "no-contact";
}

/**
 * Rank eligible shops by how much a traveller would want to hear from them.
 *
 * Rating first, then review COUNT as the tie-break, because a 5.0 from three
 * people is not better evidence than a 4.7 from four hundred - and a shop with
 * no reviews at all is a coin flip, not a lead. Distance breaks the remaining
 * ties: all else equal, nearer is genuinely better for a walk-in pickup.
 */
export function rankForMassBargain(a: Vendor, b: Vendor): number {
  // OPEN SHOPS FIRST. `openNow` has been on the Vendor since Places populated
  // it and no ranking has ever read it, while `fast_dispatch` defaults ON and
  // lifts the closed-now park entirely - so a shop Google reports CLOSED was
  // exactly as likely to be message #1 as an open one. That is the worst
  // possible order: a closed shop cannot reply, and an unanswered thread is
  // precisely the quantity WhatsApp meters.
  //
  // This is SEQUENCING, not selection. Every eligible shop still gets an
  // outbox row and every shop the traveller chose is still contacted - closed
  // ones simply go later in the batch, by which time many have opened.
  // Unknown sits between open and closed: absent hours are common for small
  // shops and must not be treated as evidence of being shut.
  const openRank = (v: Vendor) => (v.openNow === true ? 0 : v.openNow === false ? 2 : 1);
  const oa = openRank(a);
  const ob = openRank(b);
  if (oa !== ob) return oa - ob;

  const ratingOf = (v: Vendor) => (v.rating > 0 ? v.rating : 0);
  const reviewsOf = (v: Vendor) => (typeof v.reviews === "number" ? v.reviews : 0);
  // Bucket the rating to one decimal so 4.71 and 4.68 are treated as the same
  // shop quality and the review count - the far stronger signal - decides.
  const ra = Math.round(ratingOf(a) * 10);
  const rb = Math.round(ratingOf(b) * 10);
  if (ra !== rb) return rb - ra;
  const va = reviewsOf(a);
  const vb = reviewsOf(b);
  if (va !== vb) return vb - va;
  const da = typeof a.distanceKm === "number" ? a.distanceKm : Number.POSITIVE_INFINITY;
  const db = typeof b.distanceKm === "number" ? b.distanceKm : Number.POSITIVE_INFINITY;
  return da - db;
}

/**
 * The shops a mass run would contact, best first, capped by plan.
 *
 * Pure, and returns the WHOLE ranked list alongside the selection, so the
 * preview can show the traveller exactly who is about to be messaged - and who
 * was left out - before a single message exists.
 */
export function massBargainTargets(
  vendors: Vendor[],
  plan?: string | null
): { targets: Vendor[]; eligible: Vendor[]; cap: number } {
  const cap = massBargainCap(plan);
  const eligible = vendors.filter(isMassEligible).sort(rankForMassBargain);
  return { targets: eligible.slice(0, cap), eligible, cap };
}
