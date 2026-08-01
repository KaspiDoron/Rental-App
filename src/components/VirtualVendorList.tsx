"use client";

// THE VENDOR LIST, WINDOWED.
//
// A busy hunt is forty shops, and every card is a heavy component: a photo, an
// avatar, a tracker pipeline, an option list, a composer, a thread peek with
// its own poll. All of it mounted, all of it re-rendering on every activity
// tick, on a phone. The "Show 20 more" button was the old defence, and it is a
// bad one twice over - it makes the traveller do work to see shops the app
// already has, and it does nothing at all once they have tapped it, which is
// exactly when the list is heaviest.
//
// Windowing fixes both: everything is scrollable immediately, and only the rows
// near the viewport exist in the DOM. The virtualizer measures each card, so
// cards of different heights (an offer, a queued chip, an options menu) do not
// need a guessed row height.
//
// WINDOW SCROLLING, not a scroll container. The page scrolls; wrapping the list
// in its own overflow box would break scroll restoration, the sticky status
// panel and iOS momentum all at once.

import { useEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { Vendor } from "@/lib/types";

/** Estimated card height before measurement. Wrong is fine; unset is not. */
const ESTIMATE_PX = 420;
/** Rows to keep mounted beyond the viewport, so scrolling never shows a gap. */
const OVERSCAN = 4;
/** Below this width the layout is one column - the mobile-first target. */
const TWO_COLUMN_MIN_PX = 768;

export function VirtualVendorList({
  vendors,
  renderCard,
  scrollToIndex,
}: {
  vendors: Vendor[];
  renderCard: (vendor: Vendor, index: number) => React.ReactNode;
  /**
   * Bring a row into view even when it is not mounted.
   *
   * The status panel and the push deep-links jump straight to a shop, and a
   * windowed row far down the list has no DOM node to scroll to. The caller
   * bumps this and the virtualizer scrolls the page, mounting the row on the
   * way; `scrollIntoView` on the real element then does the fine positioning.
   */
  scrollToIndex?: number | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState(1);
  // The offset of the list from the top of the document. The window
  // virtualizer measures against the page, so it needs to know where we start.
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      setLanes(window.innerWidth >= TWO_COLUMN_MIN_PX ? 2 : 1);
      const top = parentRef.current?.getBoundingClientRect().top ?? 0;
      setOffset(top + window.scrollY);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [vendors.length]);

  const virtualizer = useWindowVirtualizer({
    count: vendors.length,
    estimateSize: () => ESTIMATE_PX,
    overscan: OVERSCAN,
    lanes,
    scrollMargin: offset,
    // Cards change height as offers land, so measurement has to be dynamic
    // rather than a one-time read.
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  useEffect(() => {
    if (typeof scrollToIndex !== "number" || scrollToIndex < 0) return;
    virtualizer.scrollToIndex(scrollToIndex, { align: "center" });
    // `virtualizer` is recreated every render by design; depending on it here
    // would scroll on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {items.map((item) => {
        const vendor = vendors[item.index];
        if (!vendor) return null;
        return (
          <div
            key={vendor.id}
            data-index={item.index}
            ref={virtualizer.measureElement}
            // A windowed row is absolutely positioned, so it has no inline flow
            // for `dir="rtl"` to mirror - the lane offset has to be flipped by
            // hand. globals.css swaps `left` for `right` off this class and the
            // custom property below.
            className="wd-virtual-row"
            style={{
              position: "absolute",
              top: 0,
              // Two lanes share the width; one lane takes all of it. The gap is
              // baked into the width so the columns do not touch.
              left: lanes === 2 ? `calc(${item.lane * 50}% + ${item.lane * 6}px)` : 0,
              ["--wd-lane-offset" as string]:
                lanes === 2 ? `calc(${item.lane * 50}% + ${item.lane * 6}px)` : "0px",
              width: lanes === 2 ? "calc(50% - 6px)" : "100%",
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {renderCard(vendor, item.index)}
          </div>
        );
      })}
    </div>
  );
}
