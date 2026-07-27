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
// The second half is a WebKit bug rather than a spec rule: on iOS, a
// `position: fixed` element can be composited against a STALE scroll offset and
// paint half way up the page (the "nav bar jumped into the middle of the
// screen" report). Promoting the layer to its own compositing layer with
// `translateZ(0)` is the documented fix, and re-anchoring on every visual
// viewport change is the belt behind it - the keyboard opening, the URL bar
// collapsing and an orientation flip are all moments WebKit gets this wrong.
//
// The transform lives on THIS element, which is fine: an element's own
// transform does not affect its own fixed positioning, only its descendants' -
// and descendants of this layer are meant to move with it anyway.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

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
  // Bumped on every viewport change; changing the key forces WebKit to
  // recompute the layer instead of reusing a stale composited copy.
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    setMounted(true);
    const nudge = () => setBeat((b) => (b + 1) % 1_000_000);
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    const opts = { passive: true } as AddEventListenerOptions;
    vv?.addEventListener("resize", nudge, opts);
    vv?.addEventListener("scroll", nudge, opts);
    window.addEventListener("orientationchange", nudge, opts);
    window.addEventListener("pageshow", nudge, opts);
    return () => {
      vv?.removeEventListener("resize", nudge);
      vv?.removeEventListener("scroll", nudge);
      window.removeEventListener("orientationchange", nudge);
      window.removeEventListener("pageshow", nudge);
    };
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      data-fixed-layer=""
      // An ATTRIBUTE, deliberately - not a `key`. Remounting on every visual
      // viewport tick would tear down whatever is inside (and the keyboard
      // opening is a viewport tick). Changing an attribute forces the style
      // recalculation that shakes a stale composited layer loose, and costs
      // nothing else.
      data-beat={beat}
      className={className}
      style={hostIsFixed ? { transform: "translateZ(0)", ...style } : style}
    >
      {children}
    </div>,
    document.body
  );
}
