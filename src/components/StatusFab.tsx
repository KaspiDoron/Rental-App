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
import { FixedLayer } from "./FixedLayer";

export function StatusFab({
  /** CSS selector for the panel to watch and return to. */
  target,
  label,
  /**
   * Open the panel as well as scroll to it.
   *
   * WITHOUT THIS THE BUTTON DELIVERED THE TRAVELLER TO A CLOSED DOOR. It only
   * ever called scrollIntoView, so tapping "Live status" during a live
   * negotiation scrolled forty shops back up to a COLLAPSED one-line bar - the
   * exact thing the owner reported seeing instead of the panel. Scrolling to a
   * thing and revealing it are the same intention, and splitting them meant the
   * button did the half that does not answer the question.
   */
  onOpen,
}: {
  target: string;
  label: string;
  onOpen?: () => void;
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

  // PORTALLED THROUGH FixedLayer (owner report 6 G2): as an inline `fixed`
  // child of <main> this pill depended on no ancestor ever gaining a
  // transform/filter, and it ignored the keyboard entirely - hovering over
  // panned content while the traveller typed. The layer gives it both
  // defences for free.
  return (
    <FixedLayer
      hostIsFixed
      className="layer-chrome fixed"
      style={{
        // A SLOT, not a hand-picked rem - see the bottom-right stack tokens
        // beside the z ladder in globals.css. BOTTOM-RIGHT, anchored without a
        // transform: the old bottom-centre `left-1/2 -translate-x-1/2` pill
        // was displaced outright when pop-in overwrote the centring transform.
        bottom: "var(--stack-bottom-1)",
        right: "calc(env(safe-area-inset-right, 0px) + 1rem)",
      }}
    >
      <button
        onClick={() => {
          onOpen?.();
          const el = observed.current ?? document.querySelector(target);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        aria-label={label}
        className="wd-status-fab rounded-full px-4 py-2.5 text-[12px] font-extrabold text-strong shadow-lg pop-in"
      >
        <span aria-hidden className="mr-1">↑</span>
        {label}
      </button>
    </FixedLayer>
  );
}
