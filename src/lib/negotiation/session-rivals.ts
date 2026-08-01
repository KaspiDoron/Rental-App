import type { SessionShopRow, ThreadPhase } from "../graph/types";

// THE CROSS-CHAT LEVERAGE AGGREGATOR.
//
// The traveller's single strongest card is that ten shops are quoting at once.
// The pieces to play it have existed for a while - `session.lowest`, the rival
// list, the disclosure rail that keeps the NAME out of the message - but what
// reached the prompt was every row the session read returned, with no test of
// whether the quote behind it was still a quote anyone could act on.
//
// A rival is a THREAT. That is the whole mechanism: "another shop is at 200"
// only moves a price because the traveller could plausibly go there instead. So
// a row that cannot be gone to is not leverage, it is noise - and worse, it is
// noise that spends the ONE disclosure this thread gets. Three kinds of row
// were reaching the prompt as if they were live offers:
//
//   * a shop that DECLINED, or whose thread is dead. Its 200 is not available
//     to anyone. Citing it is an argument the traveller cannot follow through.
//   * a shop with no price at all. Nothing to cite; it only crowded the list.
//   * a shop the traveller already CLOSED with. That negotiation is over, and
//     re-opening it as a threat against a third shop is incoherent.
//
// This module is deliberately a PURE predicate over rows the caller already
// read. The session read stays where it is (one query, one place); this decides
// what is fit to say. That split is what makes it testable, and what makes the
// rule reviewable in one screen.

/** Phases whose price is no longer something the traveller could act on. */
const DEAD_PHASES: ReadonlySet<ThreadPhase> = new Set<ThreadPhase>(["dead", "closed", "closing"]);

export interface RivalQuote {
  vendorId: string;
  shop: string;
  pricePerDay: number;
  currency: string;
}

export interface RivalOptions {
  /** The thread being composed for - never its own rival. */
  excludeVendorId: string;
  /** The currency the prompt reasons in. Cross-currency is invented leverage. */
  currency: string;
  /** How many to keep. The cheapest are the only ones that matter. */
  limit?: number;
  /**
   * Vendors the traveller (or the shop) took off the table - a removed shop, a
   * tombstoned thread. Passed in rather than re-read, so this stays pure.
   */
  excludeVendorIds?: Iterable<string>;
}

/**
 * The session's LIVE competing quotes, cheapest first.
 *
 * Every returned row is one the traveller could actually take: a real number,
 * in the comparable currency, from a shop that has not withdrawn.
 */
export function validRivals(rows: SessionShopRow[], opts: RivalOptions): RivalQuote[] {
  const barred = new Set(opts.excludeVendorIds ?? []);
  barred.add(opts.excludeVendorId);
  const out: RivalQuote[] = [];
  for (const r of rows) {
    if (!r.vendorId || barred.has(r.vendorId)) continue;
    if (typeof r.pricePerDay !== "number" || !Number.isFinite(r.pricePerDay) || r.pricePerDay <= 0) continue;
    if (!r.currency || r.currency !== opts.currency) continue;
    if (r.phase && DEAD_PHASES.has(r.phase)) continue;
    out.push({
      vendorId: r.vendorId,
      shop: r.vendorName || r.vendorId,
      pricePerDay: r.pricePerDay,
      currency: r.currency,
    });
  }
  out.sort((a, b) => a.pricePerDay - b.pricePerDay);
  return out.slice(0, opts.limit ?? 4);
}

/**
 * The session floor - the cheapest live quote ANYWHERE in this hunt, including
 * this shop's own.
 *
 * This one deliberately includes the current thread, because it is not
 * leverage: it is the number the F5 rule compares against so the agent never
 * bargains a shop below the best price the traveller already has. Withdrawn
 * shops are still excluded - a floor nobody can honour is not a floor.
 */
export function sessionFloor(
  rows: SessionShopRow[],
  currency: string
): { vendorId: string; shop: string; pricePerDay: number } | null {
  let best: { vendorId: string; shop: string; pricePerDay: number } | null = null;
  for (const r of rows) {
    if (!r.vendorId) continue;
    if (typeof r.pricePerDay !== "number" || !Number.isFinite(r.pricePerDay) || r.pricePerDay <= 0) continue;
    if (!r.currency || r.currency !== currency) continue;
    if (r.phase && DEAD_PHASES.has(r.phase)) continue;
    if (!best || r.pricePerDay < best.pricePerDay) {
      best = { vendorId: r.vendorId, shop: r.vendorName || r.vendorId, pricePerDay: r.pricePerDay };
    }
  }
  return best;
}

/**
 * Should this thread push the rival card at all?
 *
 * No, when this shop is ALREADY at or under the session floor - there is
 * nothing to point at, and doing it anyway is how the agent ends up arguing
 * that a shop should beat itself (the F5 failure). The prompt gets the rivals
 * as CONTEXT either way; this says whether they are a lever this turn.
 */
export function leverageIsLive(args: {
  thisShopPricePerDay?: number | null;
  rivals: RivalQuote[];
}): boolean {
  const cheapest = args.rivals[0]?.pricePerDay;
  if (typeof cheapest !== "number") return false;
  const mine = args.thisShopPricePerDay;
  if (typeof mine !== "number" || !Number.isFinite(mine)) return true; // no quote yet: it is still a lever
  return mine > cheapest;
}
