"use client";

import type { Vendor } from "@/lib/types";

// THE REAL HORIZONTAL MODE (owner report 3, item 12).
//
// The owner asked for the vendor CARDS to scroll sideways - the full card,
// swipe left and right, with a way to switch back to the vertical feed.
// QuotesRail was not that: it is a compact strip of price quotes above the
// feed. This is the main list itself on the horizontal axis: the same
// VendorCard the vertical feed renders (the page passes ONE renderCard to
// both, so the axes cannot drift), one card per snap stop.
//
// PLAIN FLEX, deliberately. The vertical list is virtualized because forty
// heavy cards on one axis is a real cost - but a hunt is capped well under
// that (24-shop mass ceiling, ~20 discovery results), and the virtual core's
// translateX lanes are exactly the RTL trap the probe flagged. A flex row
// with native scroll snapping is correct in both directions for free.
//
// Container classes are QuotesRail's own (the one proven horizontal scroller
// at 320px): the STRIP scrolls, the page never does.
export function HorizontalVendorRail({
  vendors,
  renderCard,
}: {
  vendors: Vendor[];
  renderCard: (vendor: Vendor, index: number) => React.ReactNode;
}) {
  return (
    <div
      data-testid="horizontal-vendor-rail"
      className="no-scrollbar -mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-1"
    >
      {vendors.map((v, i) => (
        <div key={v.id} className="w-[85vw] max-w-[360px] shrink-0 snap-center">
          {renderCard(v, i)}
        </div>
      ))}
    </div>
  );
}
