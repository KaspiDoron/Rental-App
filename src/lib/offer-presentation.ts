// The ONE rule for whether a shop's quoted price may be presented to the
// traveller as a real, lockable offer - shared by the results page, Will's
// compare sheet and any future surface so the rule can never drift between them.
//
// The bug this centralizes against: an e-bike quoted at a low price (the shop
// answered about the WRONG vehicle - matchesSpec === false) was surfaced as the
// "Best price so far - Lock it" card, misleading the traveller into thinking it
// matched their 125cc-scooter request. A price for a different vehicle is a
// signal for the agent to clarify, never the traveller's best deal.

export interface PresentableOffer {
  pricePerDay: number;
  currency: string;
  // false = the shop quoted a DIFFERENT vehicle. undefined (legacy rows from
  // before this field existed) is treated as matching, so old data still shows.
  matchesSpec?: boolean;
  /**
   * The vehicle-identity gate's verdict for this price (src/lib/vehicle).
   *
   * `matchesSpec` alone was never enough, and two live threads proved it: a
   * price whose vehicle nobody could name defaulted to "must be theirs", so a
   * 110cc BeAT at 400 became BEST PRICE for a traveller who had declared a 125.
   * The gate distinguishes "confirmed" from "we cannot tell yet", and only the
   * first is a deal.
   */
  vehicleStatus?: "confirmed" | "needs-confirmation" | "wrong-vehicle";
}

/**
 * An offer counts as a real deal only when it is for the requested vehicle.
 *
 * UNCONFIRMED IS NOT PRESENTABLE. That is the whole change: a price the agent
 * is still confirming the vehicle for stays visible on its card, with the
 * reason, but it can never be the headline, the "best price", or the thing a
 * Lock button books.
 */
export function isPresentableOffer(offer: PresentableOffer | undefined | null): boolean {
  if (!offer) return false;
  if (offer.vehicleStatus && offer.vehicleStatus !== "confirmed") return false;
  return offer.matchesSpec !== false;
}

/**
 * The cheapest offer that actually matches the traveller's request, within a
 * single currency (mixed-currency comparison is dishonest). Off-spec quotes are
 * excluded entirely - they can never be the "cheapest".
 */
export function cheapestPresentable<T extends { offer?: PresentableOffer }>(
  vendors: T[],
  dominantCurrency: string | null
): T | undefined {
  return vendors
    .filter(
      (v) => isPresentableOffer(v.offer) && v.offer!.currency === dominantCurrency
    )
    .sort((a, b) => a.offer!.pricePerDay - b.offer!.pricePerDay)[0];
}
