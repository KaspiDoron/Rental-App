// What we say when a traveller comes back to an old hunt and asks whether the
// prices still stand.
//
// It lives here rather than in the route because a Next route file may only
// export handlers - and because the one thing that must never drift is that the
// number in this sentence is the shop's OWN last quote, read back to them. No
// figure we invented has ever been allowed to reach a shop, and a re-check is
// not where that starts.

import { moneyLocal } from "../currency";
import { nDays } from "../copy/matrix";

export function recheckMessage(opts: {
  pricePerDay?: number | null;
  currency?: string | null;
  days?: number | null;
}): string {
  const price =
    opts.pricePerDay && opts.pricePerDay > 0
      ? moneyLocal(opts.pricePerDay, opts.currency || "USD")
      : null;
  // nDays, not a hard-coded plural: a one-day re-ask read "for 1 days".
  const stay = opts.days && opts.days > 0 ? ` for ${nDays(opts.days)}` : "";
  // W4.7: NO GREETING. A re-check only ever goes to a shop this traveller has
  // already talked to - the message lands inside an existing WhatsApp thread -
  // so "Hi again!" was a second greeting by construction, and wa-guard's
  // variance pass turned it into "Hey there! again!" on the way out.
  if (price) {
    return `Planning my trip - is ${price}/day${stay} still available with you?`;
  }
  return `Planning my trip${stay} - is the rate we discussed still available?`;
}
