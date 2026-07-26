// What we say when a traveller comes back to an old hunt and asks whether the
// prices still stand.
//
// It lives here rather than in the route because a Next route file may only
// export handlers - and because the one thing that must never drift is that the
// number in this sentence is the shop's OWN last quote, read back to them. No
// figure we invented has ever been allowed to reach a shop, and a re-check is
// not where that starts.

import { moneyLocal } from "../currency";

export function recheckMessage(opts: {
  pricePerDay?: number | null;
  currency?: string | null;
  days?: number | null;
}): string {
  const price =
    opts.pricePerDay && opts.pricePerDay > 0
      ? moneyLocal(opts.pricePerDay, opts.currency || "USD")
      : null;
  const stay = opts.days && opts.days > 0 ? ` for ${opts.days} days` : "";
  if (price) {
    return `Hi again! Planning my trip - is ${price}/day${stay} still available with you?`;
  }
  return `Hi again! Planning my trip${stay} - is the rate we discussed still available?`;
}
