// IS THAT EVEN A PRICE?
//
// The rate reader (wa/rate-expr) fixes the phrasing that produced "฿1/day" from
// "250/1day". This file exists because the NEXT phrasing will be different.
//
// There was already a sanity net on one side: a number far ABOVE the area's
// typical rate that divides cleanly by the rental length is a whole-rental
// total, and agent-loop divides it. Nothing guarded the other side, so a
// misread that came out absurdly LOW went straight onto the traveller's card
// and, worse, straight into the negotiator - which then had to bargain UP from
// a number the shop never said.
//
// The market floor is the authority that already knows what a day costs in this
// region for this class. A quote at a fifth of it is not a hard-won discount,
// it is a reading error, and the honest response is to fall back to another
// number the SAME message contained, or to have no price at all and ask.
//
// Pure - the judgement is unit-tested, not inferred from a transcript.

export interface FloorBand {
  /** The cheapest a real shop in this region rents this class for. */
  floor: number;
  /** The everyday asking rate, when known. */
  typical?: number | null;
}

/**
 * How far below the floor a quote may sit and still be believable.
 *
 * Deliberately generous: shops DO undercut the seeded floor, and a traveller
 * losing a genuine bargain is worse than showing one odd number. A fifth of the
 * floor is not undercutting - at the Krabi scooter floor that is 1 baht against
 * 250, which is the case this was built for.
 */
export const IMPLAUSIBLE_RATIO = 0.2;

/** Could a real shop be quoting this per-day rate? Unknown floor = yes.
 *  STRICTLY above the bound: the Thailand field ฿30/day (a 180/6 misdivision)
 *  passed only because the threshold landed EXACTLY on 30 (floor 150 * 0.2)
 *  and the comparison was inclusive. A boundary coincidence must never be the
 *  thing that decides a price is real. */
export function plausibleDaily(perDay: number, band?: FloorBand | null): boolean {
  if (!(perDay > 0)) return false;
  if (!band || !(band.floor > 0)) return true;
  return perDay > band.floor * IMPLAUSIBLE_RATIO;
}

/**
 * Is `chosen` the ARTIFACT of dividing another amount in the same message by
 * the rental length? "6 days 180 per day" misread as 180/6=30 leaves both 30
 * and 180 in play, and 30 * 6 reconstructs 180 exactly. Pure arithmetic - no
 * keyword is consulted, which is what makes it phrasing-proof worldwide.
 */
export function looksLikeMisdivision(
  chosen: number,
  candidates: number[],
  durationDays?: number | null
): number | null {
  if (!durationDays || durationDays <= 1 || !(chosen > 0)) return null;
  const reconstructed = candidates.find(
    (c) => c !== chosen && Math.abs(c - chosen * durationDays) / c <= 0.02
  );
  return reconstructed ?? null;
}

export interface SanityVerdict {
  /** The price to use, or null when nothing in the message was believable. */
  pricePerDay: number | null;
  /** True when the original pick was replaced or dropped. */
  corrected: boolean;
  /** Plain words for the Ops feed - always says what was seen and what was done. */
  reason?: string;
}

/**
 * Judge the chosen price against the band, and RECOVER from the same message
 * when possible.
 *
 * `candidates` are the other per-day amounts the shop's message contained. A
 * misread almost always sits beside the real number - "250/1day" carries both -
 * so the cheapest believable candidate is a better answer than no answer, and a
 * far better one than the misread.
 */
export function sanePrice(
  chosen: number,
  candidates: number[],
  band?: FloorBand | null,
  opts?: { durationDays?: number | null }
): SanityVerdict {
  if (plausibleDaily(chosen, band)) return { pricePerDay: chosen, corrected: false };

  // The misdivision repair outranks generic rescue: when the implausible pick
  // is exactly another candidate divided by the stay ("6 days 180 per day"
  // -> 30 with 180 in the same message), the DIVIDEND is the shop's number -
  // restore it rather than merely picking the cheapest believable amount.
  const dividend = looksLikeMisdivision(chosen, candidates, opts?.durationDays);
  if (dividend !== null && plausibleDaily(dividend, band)) {
    return {
      pricePerDay: dividend,
      corrected: true,
      reason: `Read ${chosen}/day, but ${chosen} x ${opts?.durationDays} reconstructs ${dividend} from the same message - the shop's number was divided by the stay. Using ${dividend}/day.`,
    };
  }

  const rescue = candidates
    .filter((c) => c !== chosen && plausibleDaily(c, band))
    .sort((a, b) => a - b)[0];

  if (rescue !== undefined) {
    return {
      pricePerDay: rescue,
      corrected: true,
      reason: `Read ${chosen}/day, which is below ${Math.round(
        (band?.floor ?? 0) * IMPLAUSIBLE_RATIO
      )} - the plausible minimum here. The same message also named ${rescue}, which is believable, so that is the price.`,
    };
  }

  return {
    pricePerDay: null,
    corrected: true,
    reason: `Read ${chosen}/day, which is below ${Math.round(
      (band?.floor ?? 0) * IMPLAUSIBLE_RATIO
    )} - the plausible minimum here, and nothing else in the message was believable. Treating this shop as having quoted no price yet.`,
  };
}
