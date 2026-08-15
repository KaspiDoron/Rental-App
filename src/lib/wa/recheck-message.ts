// What we say when a traveller comes back to an old hunt and asks whether the
// deal still stands.
//
// It lives here rather than in the route because a Next route file may only
// export handlers - and because the one thing that must never drift is that the
// numbers in this sentence are the shop's OWN, read back to them. No figure we
// invented has ever been allowed to reach a shop, and a re-check is not where
// that starts.
//
// W6.1 - "ON THE SAME CONDITIONS".
//
// The old message asked about the price and nothing else, and had an explicit
// no-price branch ("is the rate we discussed still available?") that let it be
// sent to a shop we knew nothing about. A test positively locked that branch
// in, so the owner's spec was contradicted by the suite as well as the code.
//
// The owner's rule is that a re-ask only happens when we have PRICE, DEPOSIT
// and HOW WE GET THE VEHICLE - so the message states all three, and this
// function REFUSES (returns null) when any of them is missing. The invariant
// lives in the composer rather than only in its caller: a future route cannot
// message an incomplete shop by forgetting to filter, because there is no
// sentence for it to send.

import { moneyLocal } from "../currency";
import { nDays } from "../copy/matrix";
import {
  termsComplete,
  depositPhrase,
  fulfillmentPhrase,
  type DealTerms,
} from "../deal-terms";

export interface RecheckInput extends DealTerms {
  /** Rental length, when the hunt's request captured one. */
  days?: number | null;
}

/**
 * The re-check line, or null when the deal was never complete enough to
 * re-confirm. Callers MUST treat null as "do not message this shop".
 */
export function recheckMessage(opts: RecheckInput): string | null {
  if (!termsComplete(opts)) return null;

  const price = moneyLocal(opts.pricePerDay as number, opts.currency || "USD");
  // nDays, not a hard-coded plural: a one-day re-ask read "for 1 days".
  const stay = opts.days && opts.days > 0 ? ` for ${nDays(opts.days)}` : "";
  const deposit = depositPhrase(opts, moneyLocal);
  const how = fulfillmentPhrase(opts);
  // termsComplete guarantees both, but the phrases are built from free text -
  // so the message degrades to the parts it really has rather than saying
  // "undefined" to a shop.
  const conditions = [deposit, how].filter(Boolean).join(" and ");

  // W4.7: NO GREETING. A re-check only ever goes to a shop this traveller has
  // already talked to - the message lands inside an existing WhatsApp thread -
  // so "Hi again!" was a second greeting by construction, and wa-guard's
  // variance pass turned it into "Hey there! again!" on the way out.
  const opening = `Planning my trip - is ${price}/day${stay} still available?`;
  return conditions ? `${opening} Same as before: ${conditions}?` : opening;
}
