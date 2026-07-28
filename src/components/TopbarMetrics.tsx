"use client";

import { useEffect } from "react";

// THE CHROME PUBLISHES ITS OWN HEIGHT.
//
// Anything that sticks below the top bar needs to land flush against it. Every
// page was doing that with a guessed constant (`top-16`, i.e. 64px), and a
// guess is wrong the moment anything changes: a notch is 47px on one phone and
// 0 on another, a plan badge makes the row taller, a longer brand line wraps.
// When the guess is too small the sub-row hides under the bar; when it is too
// big a strip of the scrolling page shows through the gap between them - which
// is exactly the "I am seeing behind the top bar" report.
//
// So the bar measures itself and writes the answer to `--topbar-h`. Nothing
// downstream has to know what the bar contains, and there is no number to keep
// in sync. Purely a measurement: it never moves an element itself.
export function TopbarMetrics() {
  useEffect(() => {
    const root = document.documentElement;
    let bar: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;

    // DE-DUPED. A custom property on documentElement INHERITS, so writing it
    // invalidates style for the entire document subtree - which on the results
    // screen is hundreds of vendor cards. Writing the same value again is pure
    // waste, and this had no guard beyond `h > 0`, so every observer tick,
    // resize and orientation change paid for a full-document invalidation
    // whether or not anything had moved.
    let last = -1;
    const publish = () => {
      if (!bar) return;
      const h = Math.round(bar.getBoundingClientRect().height);
      // Ignore a zero - the element exists but has not been laid out yet, and
      // publishing 0 would flash the sub-row up under the brand line.
      if (h <= 0 || h === last) return;
      last = h;
      root.style.setProperty("--topbar-h", `${h}px`);
    };

    // The bar belongs to the PAGE, not the layout, so it arrives (and is
    // replaced) on every route change. Re-attach whenever it does.
    const attach = () => {
      const next = document.querySelector<HTMLElement>(".topbar");
      if (next === bar) return;
      ro?.disconnect();
      bar = next;
      if (!bar) return;
      ro = new ResizeObserver(publish);
      ro.observe(bar);
      publish();
    };

    attach();
    // The bar belongs to the page, so it is replaced on a ROUTE change - not on
    // every DOM mutation. Observing the whole body ran a document-wide
    // querySelector on every mutation batch, and DomTranslator mutates the body
    // on a timer, so this fired continuously instead of on navigation. One
    // shallow observation of the body's own child list is enough to notice a
    // page swap, and costs nothing while a list re-renders deeper in the tree.
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true });
    window.addEventListener("resize", publish);
    window.addEventListener("orientationchange", publish);

    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", publish);
      window.removeEventListener("orientationchange", publish);
    };
  }, []);

  return null;
}
