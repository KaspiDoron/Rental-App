// THE HORIZONTAL AXIS, AS A FUNCTION - Wave C / M10.
//
// Which shops belong on the quotes rail, and in what order. Pure and separate
// from the component for the same reason `progress.ts` is separate from the
// progress bar: the rule is the interesting part, it is testable without a
// DOM, and there is exactly one place to read it.

import type { Vendor } from "./types";

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
export function railVendors(vendors: Vendor[]): Vendor[] {
  return quotedVendors(vendors).slice(0, RAIL_MAX);
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
export function quotedVendors(vendors: Vendor[]): Vendor[] {
  return vendors
    .filter((v) => v.offer && v.offer.pricePerDay > 0)
    .slice()
    .sort((a, b) => a.offer!.pricePerDay - b.offer!.pricePerDay);
}
