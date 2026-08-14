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
//     bar's laid-out size, and anything that re-measures chrome on scroll is a
//     layout -> style -> layout loop running at scroll frequency. `translate3d`
//     changes nothing any observer can see.
//   - NO PER-FRAME LAYOUT READ. `scrollY` is a cheap property, not a forced
//     reflow, and it is read inside one rAF per burst of events rather than per
//     event. The single `getBoundingClientRect` below runs only on a state
//     FLIP - a couple of times per scroll gesture, not sixty times a second.
//   - NO REACT STATE. A setState per scroll re-renders the page; this writes one
//     attribute on two elements, so the browser handles the move on the
//     compositor and React never wakes up.
//   - `will-change` ONLY WHILE MOVING. Left on permanently it pins a compositor
//     layer for the life of the page, which is the cost it was meant to avoid.
//
// ONLY THE BRAND ROW COLLAPSES NOW. The views bar (List/Map/Activity +
// Feed/Swipe) used to pin below the top bar and get collapsed alongside it;
// the owner reported it "blocks the whole screen". It is now a normal in-flow
// element (globals.css .substick carries no position:sticky), so it simply
// scrolls off with the page and this hook no longer touches it - which also
// deletes the pinned-vs-in-flow rect read that used to run on every flip.
//
// The bar keeps its own height, so nothing below it shifts: CLS stays zero
// because the element still occupies its box, it is merely drawn higher.

/** Scrolled past this before anything hides - a short flick must not collapse. */
const ARM_PX = 64;
/** Direction changes smaller than this are noise (rubber-band, momentum). */
const HYSTERESIS_PX = 6;

/**
 * Collapse the chrome on scroll-down, restore on scroll-up.
 *
 * Attaches to whatever `.topbar` / `.substick` are on the page, so it needs no
 * props and no coordination with the page component. Both are re-resolved on
 * every flip because the sub-nav mounts conditionally - it only exists once
 * there are results.
 */
export function useHeaderCollapse(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    // Respect the system setting - this is decoration, not function.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let lastY = window.scrollY;
    let collapsed = false;
    let ticking = false;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;

    // Only the brand row now. The views bar scrolls off in flow and is not
    // touched here - so there is no rect read on a flip at all.
    const bars = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>(".topbar"));

    const apply = (next: boolean) => {
      if (next === collapsed) return;
      const all = bars();
      if (all.length === 0) return;
      collapsed = next;
      for (const el of all) {
        // Promote for the duration of the move only.
        el.style.willChange = "transform";
        el.dataset.collapsed = next ? "true" : "false";
      }
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        for (const el of bars()) el.style.willChange = "";
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
      for (const el of bars()) {
        el.style.willChange = "";
        delete el.dataset.collapsed;
      }
    };
  }, [enabled]);
}
