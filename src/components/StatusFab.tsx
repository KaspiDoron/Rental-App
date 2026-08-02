"use client";

// FORTY SHOPS DEEP, WITH NO WAY BACK.
//
// The live status panel is where the traveller finds out what the agents are
// actually doing - and it sits at the TOP of a list that is now unbounded
// (nothing paginates it any more). Scroll far enough into a busy hunt and the
// only route back is a long flick, on a phone, one-handed, while a negotiation
// is running.
//
// So: a floating button that appears only once the panel has scrolled out of
// view, and takes them straight back to it. It hides itself the moment the
// panel is visible again, because a control that points at something already on
// screen is clutter.
//
// It is deliberately an IntersectionObserver on the panel rather than a scroll
// threshold: a scroll position is a guess about where the panel is, and it is
// wrong the moment the header collapses, a banner appears, or the list
// re-flows. Observing the element itself is simply correct.

import { useEffect, useRef, useState } from "react";

export function StatusFab({
  /** CSS selector for the panel to watch and return to. */
  target,
  label,
}: {
  target: string;
  label: string;
}) {
  const [show, setShow] = useState(false);
  const observed = useRef<Element | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The panel mounts with the results, which arrive after this component
    // does. Poll briefly for it rather than assuming it is already there.
    const attach = () => {
      if (cancelled) return;
      const el = document.querySelector(target);
      if (!el) {
        timer = setTimeout(attach, 400);
        return;
      }
      observed.current = el;
      observer = new IntersectionObserver(
        ([entry]) => setShow(!entry.isIntersecting),
        // A sliver counts as visible: the button should not flicker back on
        // while the panel is still half on screen.
        { threshold: 0.15 }
      );
      observer.observe(el);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    attach();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [target]);

  if (!show) return null;

  return (
    <button
      onClick={() => {
        const el = observed.current ?? document.querySelector(target);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
      aria-label={label}
      // BOTTOM-RIGHT, AND ANCHORED WITHOUT A TRANSFORM.
      //
      // This used to be a bottom-CENTRE pill positioned with
      // `left-1/2 -translate-x-1/2`, which put it directly over the middle of
      // the tab bar - and the `pop-in` animation then overwrote the centring
      // transform outright (see globals.css), so it rendered with its left edge
      // on the viewport centre line. Anchoring to `right` needs no transform at
      // all, so no animation can ever displace it again.
      //
      // `bottom` keeps it clear of the home indicator on a notched phone and of
      // the navigation that owns the bottom of every screen.
      className="wd-status-fab layer-chrome fixed rounded-full px-4 py-2.5 text-[12px] font-extrabold text-strong shadow-lg pop-in"
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.25rem)",
        right: "calc(env(safe-area-inset-right, 0px) + 1rem)",
      }}
    >
      <span aria-hidden className="mr-1">↑</span>
      {label}
    </button>
  );
}
