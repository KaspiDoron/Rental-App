"use client";

// WillGuideOverlay - Will standing ON the UI, not in a drawer. A floating
// speech card anchored to the exact element the user should touch next, plus a
// soft breathing spotlight ring around that element. Actions are 1-tap chips
// that DO the thing (navigate, open the builder, focus the input) - the user
// never has to type to follow guidance.
//
// Mechanics: the anchor is a CSS selector; we measure its viewport rect and
// place a fixed-position card via the pure placeBubble() (unit-tested, clamps
// to the viewport, prefers ABOVE the anchor since thumbs cover what's below).
// Re-measures on scroll/resize and on a slow heartbeat for async layout shifts.
// If the anchor is missing or scrolled away, the card hides - a bubble pointing
// at nothing reads as broken.
//
// Motion is the repo's existing CSS (pop-in, soft-pulse) - deliberately no
// animation library; everything must degrade gracefully.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FixedLayer } from "../FixedLayer";
import { WillAvatar } from "./WillAvatar";
import { placeBubble, type BubblePlacement, type Rect } from "@/lib/will-assistant";
import { useI18n } from "@/lib/i18n";

export interface WillAction {
  label: string;
  /** May be async - the chip shows a busy state until it settles, and every
   *  chip is disabled while ANY action is in flight (one move at a time). */
  onAction: () => void | Promise<unknown>;
  primary?: boolean;
  /** Dismiss the whole guidance card once this action settles. For outbound
   *  moves (Push harder) the card lingering with a live chip was exactly how
   *  repeated taps stacked near-identical bargains in the field. */
  dismissOnDone?: boolean;
}

export function WillGuideOverlay({
  anchor,
  text,
  actions = [],
  tone = "guide",
  onDismiss,
  onOpenChat,
}: {
  /** CSS selector of the element this guidance points at. */
  anchor: string;
  /** Max two short sentences - Will is a concierge, not a terms page. */
  text: string;
  actions?: WillAction[];
  tone?: "guide" | "celebrate";
  onDismiss?: () => void;
  onOpenChat?: () => void;
}) {
  const { t } = useI18n();
  // STATE, not a bare ref, deliberately (wave 4.1 found this in the browser):
  // the placement effect below must RE-RUN when the card's DOM node actually
  // attaches, and `ref.current` is not reactive. When the portalled card
  // mounted on a later render than the one that set `anchorRect`, the effect's
  // deps had not changed, placement never ran, and the card sat permanently
  // at visibility:hidden - Will was invisible until the first scroll happened
  // to nudge the anchor rect. A callback-ref through state makes the node's
  // arrival a dependency like any other.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const attachCard = (el: HTMLDivElement | null) => {
    cardRef.current = el;
    setCardEl(el);
  };
  // The label of the chip whose action is currently running, if any. While it
  // is set every chip is disabled - a second tap during a slow outbound is the
  // same intent, not a new instruction.
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  // The last rect we COMMITTED, so a scroll that did not actually move the
  // anchor costs nothing at all.
  const lastRect = useRef<Rect | null>(null);
  const [pos, setPos] = useState<BubblePlacement | null>(null);

  // Track the anchor's viewport rect: events + a slow heartbeat for async
  // layout shifts (images, translated copy, panels expanding).
  useEffect(() => {
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const el = document.querySelector(anchor);
      if (!el) {
        setAnchorRect(null);
        return;
      }
      const r = (el as HTMLElement).getBoundingClientRect();
      const offscreen =
        r.bottom < 0 || r.top > window.innerHeight || r.width === 0 || r.height === 0;
      // BAIL ON AN UNCHANGED RECT. This used to allocate a fresh object on every
      // scroll event, so React could never bail out of the re-render - a new
      // object is never === the old one, however identical its numbers.
      const next = offscreen
        ? null
        : { top: r.top, left: r.left, width: r.width, height: r.height };
      const prev = lastRect.current;
      const same =
        (next === null && prev === null) ||
        (next !== null &&
          prev !== null &&
          Math.abs(next.top - prev.top) < 0.5 &&
          Math.abs(next.left - prev.left) < 0.5 &&
          Math.abs(next.width - prev.width) < 0.5 &&
          Math.abs(next.height - prev.height) < 0.5);
      if (same) return;
      lastRect.current = next;
      setAnchorRect(next);
    };
    measure();
    // ONE MEASURE PER FRAME. Unthrottled, this read layout on every scroll
    // event and the placement effect then read it again after React had written
    // top/left - a read-after-write forced synchronous reflow, twice per event.
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        measure();
      });
    };
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("scroll", onScroll, opts);
    window.addEventListener("resize", onScroll, opts);
    const beat = setInterval(measure, 2000);
    return () => {
      alive = false;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearInterval(beat);
    };
  }, [anchor]);

  // Position after the card has real dimensions (text/i18n can change them).
  useLayoutEffect(() => {
    if (!anchorRect || !cardEl) {
      setPos(null);
      return;
    }
    const c = cardEl.getBoundingClientRect();
    setPos(
      placeBubble(anchorRect, { width: c.width, height: c.height }, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    );
  }, [anchorRect, cardEl, text, actions.length]);

  if (!anchorRect) return null;

  const celebrate = tone === "celebrate";

  return (
    // PORTALLED, NOT INLINE.
    //
    // Both children are `position: fixed` positioned from viewport coordinates
    // (getBoundingClientRect). That only means the viewport while no ancestor
    // creates a containing block - and `transform`, `filter`, `backdrop-filter`
    // and `contain` all do. Rendered inline, Will sat inside the page canvas
    // and inside glass cards, so the moment either grew a filter his card was
    // measured against the viewport and PAINTED against something else: off the
    // edge of the screen. FixedLayer puts him on <body>, where the coordinates
    // he is given are the coordinates he is drawn at.
    <FixedLayer hostIsFixed={false}>
      {/* Breathing spotlight ring around the target element. */}
      <div
        aria-hidden
        className="soft-pulse pointer-events-none fixed z-[998] rounded-2xl"
        style={{
          top: anchorRect.top - 5,
          left: anchorRect.left - 5,
          width: anchorRect.width + 10,
          height: anchorRect.height + 10,
          boxShadow: celebrate
            ? "0 0 0 2px rgba(37,211,102,.75), 0 0 26px 4px rgba(37,211,102,.35)"
            : "0 0 0 2px rgba(93,138,255,.75), 0 0 26px 4px rgba(93,138,255,.30)",
        }}
      />

      {/* The speech card. Invisible until measured+placed to avoid a jump.
          data-tour="will": the onboarding tour's "Meet Will" step anchors on
          this - the step shipped pointing at an attribute NO element carried
          (owner report 3, re-verification item 10), so it silently degraded to
          an unanchored centered card. This card IS Will on screen. */}
      <div
        ref={attachCard}
        role="status"
        data-tour="will"
        className={`pop-in fixed z-[999] w-[min(21rem,calc(100vw-24px))] rounded-2xl border-2 bg-card p-3 shadow-2xl ${
          celebrate ? "border-[#25D366]/60" : "border-brandblue/50"
        }`}
        style={
          pos
            ? { top: pos.top, left: pos.left }
            : { top: 0, left: 0, visibility: "hidden" }
        }
      >
        {/* Arrow, kept pointing at the anchor even after horizontal clamping. */}
        {pos && (
          <span
            aria-hidden
            className={`absolute h-3 w-3 rotate-45 border-2 bg-card ${
              celebrate ? "border-[#25D366]/60" : "border-brandblue/50"
            } ${
              pos.placement === "above"
                ? "-bottom-[7px] border-l-0 border-t-0"
                : "-top-[7px] border-b-0 border-r-0"
            }`}
            style={{ left: pos.arrowLeft - 6 }}
          />
        )}

        <div className="flex items-start gap-2.5">
          <div className="shrink-0">
            <WillAvatar size={34} mood={celebrate ? "celebrating" : "idle"} wave={celebrate} />
          </div>
          <p className="min-w-0 flex-1 pt-0.5 text-[12.5px] font-bold leading-snug text-strong">
            {text}
          </p>
          {onDismiss && (
            <button
              onClick={onDismiss}
              aria-label={t("Dismiss")}
              className="btn btn-sm -mr-1 -mt-1 h-6 w-6 shrink-0 rounded-full text-faint hover:text-soft"
            >
              ✕
            </button>
          )}
        </div>

        {(actions.length > 0 || onOpenChat) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[44px]">
            {actions.map((a) => (
              <button
                key={a.label}
                onClick={async () => {
                  if (busyLabel) return;
                  setBusyLabel(a.label);
                  try {
                    await a.onAction();
                  } finally {
                    setBusyLabel(null);
                    if (a.dismissOnDone) onDismiss?.();
                  }
                }}
                disabled={busyLabel !== null}
                aria-busy={busyLabel === a.label}
                className={`btn btn-sm rounded-xl px-3 py-1.5 text-[11.5px] font-extrabold disabled:opacity-60 ${
                  a.primary
                    ? celebrate
                      ? "bg-[#25D366] text-white"
                      : "bg-brandblue text-white"
                    : "chip bg-card2 text-brandblue"
                }`}
              >
                {busyLabel === a.label ? t("On it…") : a.label}
              </button>
            ))}
            {onOpenChat && (
              <button
                onClick={onOpenChat}
                className="btn btn-sm rounded-xl px-2.5 py-1.5 text-[11.5px] font-extrabold text-faint hover:text-brandblue"
              >
                {t("Ask Will…")}
              </button>
            )}
          </div>
        )}
      </div>
    </FixedLayer>
  );
}
