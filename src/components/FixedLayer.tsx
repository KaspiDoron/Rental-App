"use client";

// One place for everything that must stay glued to the VIEWPORT: the bottom
// navigation, the Ask-Will chip, Will's guidance card.
//
// Why a portal. `position: fixed` is only viewport-relative while no ancestor
// creates a containing block - and `transform`, `filter`, `backdrop-filter`,
// `perspective`, `contain` and `will-change` all do. This app has every one of
// them in the tree (the sticky blurred topbar, `.lift`'s `will-change:
// transform`, the map panes, the blur-lock veil), so a fixed child of the page
// is one style change away from being pinned inside a card instead of the
// screen. Modal.tsx already learned this the hard way and portals for exactly
// this reason.
//
// The second half is the KEYBOARD. On iOS, opening the software keyboard does
// not resize the layout viewport - it shrinks the VISUAL viewport and lets the
// browser scroll the page to keep the focused field visible, while
// `position: fixed` elements stay anchored to the layout viewport. The result
// is the owner's screenshot: the tab bar composited half way up the screen,
// over the form. The previous defence here bumped a `data-beat` attribute that
// no CSS selected - a style recalculation, but nothing that MOVED the bar -
// which is why the report came back. The honest response is to measure the
// keyboard inset from the visual viewport and HIDE the fixed chrome while a
// field is focused: a bar lifted above the keyboard would cover the field it
// belongs under either way, and hiding also stops the bar from swallowing the
// taps of anything the keyboard pushed up (the place-autocomplete dropdown).
//
// The transform lives on THIS element, which is fine: an element's own
// transform does not affect its own fixed positioning, only its descendants' -
// and descendants of this layer are meant to move with it anyway.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Visual-viewport insets below this are browser chrome (the iOS URL bar
 * collapse is ~60px); above it, a software keyboard (the smallest are ~180px).
 */
const KEYBOARD_MIN_PX = 80;
/** What the focusin fallback assumes when the engine has no visualViewport. */
const FALLBACK_KEYBOARD_PX = 260;

function isEditable(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.matches("input, textarea, select, [contenteditable]") ||
      t.isContentEditable)
  );
}

export function FixedLayer({
  children,
  className = "",
  style,
  hostIsFixed = true,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /**
   * TRUE  - this layer IS the fixed element (the tab bar). It gets the
   *         compositing transform, which is safe: an element's own transform
   *         does not affect its own fixed positioning.
   * FALSE - the fixed elements are the CHILDREN (Will's ring and card). The
   *         host must then carry no transform at all, or it becomes their
   *         containing block and re-creates the exact bug this component
   *         exists to prevent.
   */
  hostIsFixed?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  // Bumped on the viewport events WebKit historically mis-composites through
  // (keyboard, URL bar, orientation, bfcache restore). It flows into the
  // host's inline style below, so every bump is a real style change - the old
  // version wrote it to a `data-beat` attribute no CSS selected.
  const [beat, setBeat] = useState(0);
  /** Height of the software keyboard, measured from the visual viewport. */
  const [kbInset, setKbInset] = useState(0);

  useEffect(() => {
    setMounted(true);
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const opts = { passive: true } as AddEventListenerOptions;

    const measure = () => {
      if (!vv) return;
      const kb = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      // Bail out on sub-pixel noise so plain page scrolling (where the inset
      // does not change) never re-renders this portal - re-rendering the
      // backdrop-filtered tab bar per scroll frame was this file's original
      // performance sin.
      setKbInset((prev) => (Math.abs(prev - kb) < 1 ? prev : kb));
    };
    const nudge = () => {
      setBeat((b) => (b + 1) % 1_000_000);
      measure();
    };

    // `scroll` matters WHILE the keyboard is open: iOS pans the visual
    // viewport to keep the focused field in view, and `offsetTop` (part of the
    // inset math) changes on those pans without a resize. rAF-throttled, and
    // the bail-out above makes the no-keyboard case free.
    let raf = 0;
    const onVvScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    vv?.addEventListener("resize", nudge, opts);
    vv?.addEventListener("scroll", onVvScroll, opts);
    window.addEventListener("orientationchange", nudge, opts);
    window.addEventListener("pageshow", nudge, opts);

    // Engines without visualViewport cannot measure the keyboard at all - a
    // focused text field is the best available signal that one is up.
    const onFocusIn = (e: FocusEvent) => {
      if (!vv && isEditable(e.target)) setKbInset(FALLBACK_KEYBOARD_PX);
    };
    const onFocusOut = () => {
      if (!vv) setKbInset(0);
    };
    document.addEventListener("focusin", onFocusIn, opts);
    document.addEventListener("focusout", onFocusOut, opts);

    measure();
    return () => {
      vv?.removeEventListener("resize", nudge);
      vv?.removeEventListener("scroll", onVvScroll);
      window.removeEventListener("orientationchange", nudge);
      window.removeEventListener("pageshow", nudge);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  if (!mounted) return null;

  const kbHidden = hostIsFixed && kbInset > KEYBOARD_MIN_PX;

  return createPortal(
    <div
      data-fixed-layer=""
      aria-hidden={kbHidden || undefined}
      className={className}
      style={
        hostIsFixed
          ? {
              // Own compositing layer (translateZ) as before; slid fully off
              // screen while the keyboard is up so it can neither float mid
              // screen nor swallow taps meant for content above it.
              transform: kbHidden
                ? "translateY(120%) translateZ(0)"
                : "translateZ(0)",
              transition: "transform 160ms ease",
              ["--kb-inset" as string]: `${kbInset}px`,
              ["--wd-vv-beat" as string]: String(beat),
              ...style,
            }
          : style
      }
    >
      {children}
    </div>,
    document.body
  );
}
