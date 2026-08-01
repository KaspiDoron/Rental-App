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

/** The ceiling the owner set for one run, whatever the plan allows in a window. */
export const MASS_BARGAIN_MAX = 15;

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
