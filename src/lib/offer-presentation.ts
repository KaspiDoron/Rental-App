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
}

/** An offer counts as a real deal only when it is for the requested vehicle. */
export function isPresentableOffer(offer: PresentableOffer | undefined | null): boolean {
  return Boolean(offer) && offer!.matchesSpec !== false;
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
