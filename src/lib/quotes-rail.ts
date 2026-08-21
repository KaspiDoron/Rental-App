// THE HORIZONTAL AXIS, AS A FUNCTION - Wave C / M10.
//
// Which shops belong on the quotes rail, and in what order. Pure and separate
// from the component for the same reason `progress.ts` is separate from the
// progress bar: the rule is the interesting part, it is testable without a
// DOM, and there is exactly one place to read it.

import type { Vendor } from "./types";
import { rankPresentable, isPresentableOffer } from "./offer-presentation";

/**
 * How many quotes the rail will show.
 *
 * Bounded so the strip stays un-windowed and cheap. Past a dozen the rail has
 * stopped being a shortcut and become a second feed, which is precisely what
 * it must not turn into.
 */
export const RAIL_MAX = 12;

/**
 * The minimum number of quotes worth a rail.
 *
 * With one quote the rail says nothing the card beneath it does not already
 * say, and it costs a row of vertical space on a 320px screen to say it.
 */
export const RAIL_MIN = 2;

/**
 * The quoted shops, cheapest per day first.
 *
 * COPIES BEFORE SORTING. `.sort()` is in place, and the array handed in is the
 * one the vertical feed is rendering - sorting it here would silently reorder
 * the feed as a side effect of drawing the rail.
 *
 * A price of 0 is not a quote. It is a parse failure, and this app has already
 * shipped a card reading "bargained to 0".
 */
export function railVendors(vendors: Vendor[], dominantCurrency?: string | null): Vendor[] {
  return quotedVendors(vendors, dominantCurrency).slice(0, RAIL_MAX);
}

/**
 * Every shop with a live quote, cheapest first - the rail's input BEFORE the
 * cap.
 *
 * Split out because the header was counting the capped array. With thirteen
 * quotes in, "Quotes so far - 12 shops" is a silently truncated number
 * presented as a total, which is the same defect as the Trips headline that
 * summed a daily rate and captioned it a trip total. The cap is a display
 * bound, not a fact about the hunt, and the header now says so.
 */
export function quotedVendors(vendors: Vendor[], dominantCurrency?: string | null): Vendor[] {
  // ONE BEST-PRICE RULE (D4). The rail used to admit every number: a price
  // for the WRONG vehicle, a quote from a shop that had run out, and - with
  // mixed currencies - a raw-number sort that put 200 THB "ahead of" 5 USD.
  // The presentable set leads (dominant currency, cheapest first, same rule
  // as the BEST PRICE rollup); presentable quotes in OTHER currencies follow,
  // visible but never wearing first place against a number they cannot
  // honestly be compared with.
  const lead = rankPresentable(vendors, dominantCurrency ?? null);
  if (!dominantCurrency) return lead;
  const inLead = new Set(lead);
  const other = rankPresentable(vendors, null).filter((v) => !inLead.has(v));
  return [...lead, ...other];
}

/** Re-export so the rail component can label unpresentable quotes honestly. */
export { isPresentableOffer };
