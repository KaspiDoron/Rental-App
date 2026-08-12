"use client";

// THE HORIZONTAL AXIS - Wave C / M10.
//
// The vertical feed is ordered by whatever the traveller sorted on, and it
// contains every shop: the ones still being contacted, the ones that went
// quiet, and the handful that actually answered with a price. Finding the
// second-cheapest quote means scrolling past all of them. That is the problem
// a second axis solves, and it is the only one worth adding - a horizontal
// copy of the same feed would be two places to look and one more thing to
// disagree with itself.
//
// So the rail carries EXACTLY the shops that have a live quote, cheapest
// first, and tapping one drives the vertical feed to that card. Two axes, one
// list, one selection.
//
// THREE RULES, EACH FROM A DEFECT THIS APP HAS ALREADY PAID FOR:
//
// 1. IT DERIVES NOTHING. It is handed the same array the feed renders, already
//    filtered and sorted, and re-orders a copy by price. This app has shipped
//    four disagreeing shop counters; a rail computing its own idea of "which
//    shops matter" would be the fifth.
// 2. IT DOES NOT TOUCH THE VIRTUALIZER. The windowed list scrolls the PAGE on
//    purpose - a scroll container would break scroll restoration, the sticky
//    panel and iOS momentum at once. The rail is a separate, BOUNDED strip
//    above it with its own overflow, so it needs no windowing and cannot
//    interfere with the one that exists.
// 3. IT NEVER PRINTS A CONVERTED PRICE AS THE SHOP'S. Offers arrive in the
//    shop's own money and are rendered in it, same as the card.

import type { Vendor } from "@/lib/types";
import { moneyLocal } from "@/lib/currency";
// The ordering rule lives in lib, pure and testable without a DOM - same split
// as progress.ts and the progress bar.
import { railVendors, quotedVendors, RAIL_MIN } from "@/lib/quotes-rail";

export function QuotesRail({
  vendors,
  selectedId,
  onPick,
  t,
}: {
  /** The SAME array the vertical feed renders - already filtered and sorted. */
  vendors: Vendor[];
  selectedId?: string | null;
  /** Drives the vertical feed. The caller already owns this jump. */
  onPick: (id: string) => void;
  t: (s: string) => string;
}) {
  const rail = railVendors(vendors);
  if (rail.length < RAIL_MIN) return null;
  // THE HEADER COUNTED THE CAPPED ARRAY. With thirteen quotes in it read
  // "Quotes so far - 12 shops", which is a silently truncated number presented
  // as a total: the same defect as a daily rate captioned as a trip total. The
  // cap is a display bound on the strip, not a fact about the hunt.
  const quoted = quotedVendors(vendors).length;
  const hidden = quoted - rail.length;

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5">
        <span className="text-[12px] font-extrabold text-strong">
          💰 {t("Quotes so far")}
        </span>
        <span className="text-[11px] font-bold text-faint">
          {quoted} {quoted === 1 ? t("shop") : t("shops")}
          {/* Say what is not on the strip rather than letting the count shrink
              to fit it. The shops are all in the feed below - the rail is a
              shortcut to the cheapest, not the whole set. */}
          {hidden > 0 ? ` · ${t("showing the cheapest")} ${rail.length}` : ""}
        </span>
      </div>
      {/* The strip owns its overflow, so the PAGE never scrolls sideways -
          that is the mobile-first rule this could most easily break. `dir` is
          inherited, so RTL mirrors it for free: these are normal flow children,
          not the absolutely-positioned rows the windowed list has to flip by
          hand. */}
      <div
        // `overscroll-x-contain` is not decoration. A horizontal swipe that
        // reaches the end of an overflow container CHAINS to the document, and
        // on iOS a chained horizontal swipe is the back gesture - so flicking
        // past the last quote could navigate away from the hunt entirely. The
        // scroll stops at the strip's own edge.
        className="no-scrollbar -mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-1"
        role="list"
        aria-label={t("Quotes so far")}
      >
        {rail.map((v, i) => {
          const offer = v.offer!;
          const dropped = offer.pricePerDay < offer.listPricePerDay;
          return (
            <button
              key={v.id}
              role="listitem"
              onClick={() => onPick(v.id)}
              className={`w-[148px] shrink-0 snap-start rounded-2xl border-2 p-2.5 text-left transition-colors ${
                selectedId === v.id
                  ? "border-brandblue bg-brandblue-soft"
                  : "border-line bg-card"
              }`}
            >
              <div className="flex items-center gap-1">
                {/* Cheapest first, so the first tile is the one to beat. */}
                {i === 0 && (
                  <span className="rounded-full bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-savings">
                    {t("Best price")}
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-[12px] font-extrabold text-strong">
                {v.name}
              </div>
              <div className="mt-0.5 text-[15px] font-extrabold text-strong">
                {moneyLocal(offer.pricePerDay, offer.currency)}
                <span className="text-[11px] font-bold text-faint">/{t("day")}</span>
              </div>
              {/* A drop is the shop's own movement - first price against live
                  price - not a comparison with any other shop. */}
              {dropped && (
                <div className="mt-0.5 text-[10px] font-extrabold text-savings">
                  {t("down from")} {moneyLocal(offer.listPricePerDay, offer.currency)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
