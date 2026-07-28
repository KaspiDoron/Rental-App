"use client";

import { useEffect } from "react";

// RECLAIM THE SCREEN, WITHOUT TOUCHING LAYOUT.
//
// The header stack costs roughly 160px of permanent chrome on a 390px phone -
// the brand row plus the sticky List/Map/Activity row - before a single shop
// card is visible. It should get out of the way while you are reading down a
// list and come back the moment you look up.
//
// Every constraint here is a lesson this repo already paid for:
//
//   - TRANSFORM ONLY. Animating height/padding/max-height would change the
//     bar's laid-out size, which TopbarMetrics measures with a ResizeObserver
//     and republishes as `--topbar-h` - a genuine observer -> layout -> observer
//     loop, running at scroll frequency. `translate3d` changes nothing the
//     observer can see.
//   - NO PER-FRAME LAYOUT READ. `scrollY` is a cheap property, not a forced
//     reflow, and it is read inside one rAF per burst of events rather than per
//     event.
//   - NO REACT STATE. A setState per scroll re-renders the page; this writes one
//     CSS variable on the bar itself, so the browser handles it on the
//     compositor and React never wakes up.
//   - `will-change` ONLY WHILE MOVING. Left on permanently it pins a compositor
//     layer for the life of the page, which is the cost it was meant to avoid.
//
// The bar keeps its own height, so nothing below it shifts: CLS stays zero
// because the element still occupies its box, it is merely drawn higher.

/** Scrolled past this before anything hides - a short flick must not collapse. */
const ARM_PX = 64;
/** Direction changes smaller than this are noise (rubber-band, momentum). */
const HYSTERESIS_PX = 6;

/**
 * Collapse `.topbar` on scroll-down, restore on scroll-up.
 *
 * Attaches to whatever `.topbar` is on the page, so it needs no props and no
 * coordination with the page component.
 */
export function useHeaderCollapse(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    // Respect the system setting - this is decoration, not function.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const bar = document.querySelector<HTMLElement>(".topbar");
    if (!bar) return;

    let lastY = window.scrollY;
    let collapsed = false;
    let ticking = false;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (next: boolean) => {
      if (next === collapsed) return;
      collapsed = next;
      // Promote for the duration of the move only.
      bar.style.willChange = "transform";
      bar.dataset.collapsed = next ? "true" : "false";
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        bar.style.willChange = "";
      }, 400);
    };

    const read = () => {
      ticking = false;
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < HYSTERESIS_PX) return;
      lastY = y;
      // Near the top the bar is always present - there is nothing to reclaim
      // and a bar that hides at rest reads as a glitch.
      if (y < ARM_PX) return apply(false);
      apply(dy > 0);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(read);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(clearTimer);
      bar.style.willChange = "";
      delete bar.dataset.collapsed;
    };
  }, [enabled]);
}
