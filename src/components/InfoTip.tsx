"use client";

// Tap-to-open "i" info popup, lifted from the WA-security policy help pattern in
// admin/page.tsx into a reusable single-open widget. Every engine metric gets an
// InfoTip that explains, in plain language, WHAT the number means and WHAT TO DO
// if it drifts. Only one popup is open at a time (a shared context tracks the
// open id) so the panel never fills with stacked bubbles. Mobile-first: the
// bubble clamps to the viewport width and closes on outside tap or Escape.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface InfoTipCtx {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}
const Ctx = createContext<InfoTipCtx | null>(null);

/** Wrap a panel so its InfoTips share a single-open state. */
export function InfoTipProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);

  // Outside tap / Escape closes whatever is open.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest("[data-infotip]")) setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [openId]);

  return <Ctx.Provider value={{ openId, setOpenId }}>{children}</Ctx.Provider>;
}

export interface InfoTipProps {
  /** Stable unique id so only one popup opens at a time. */
  id: string;
  /** Metric name shown as the popup heading. */
  label: string;
  /** Plain-language "what this number means". */
  what: string;
  /** "What to do if it drifts" - the actionable guidance. */
  drift?: string;
}

export function InfoTip({ id, label, what, drift }: InfoTipProps) {
  const ctx = useContext(Ctx);
  // Fall back to local state if used outside a provider (still works, just not
  // single-open coordinated).
  const [localOpen, setLocalOpen] = useState(false);
  const open = ctx ? ctx.openId === id : localOpen;
  const toggle = () => {
    if (ctx) ctx.setOpenId(open ? null : id);
    else setLocalOpen((v) => !v);
  };

  // EDGE-AWARE OFFSET: the bubble is centered on the "i" button
  // (left-1/2 -translate-x-1/2), which pushes it off-screen when the button
  // sits near the left or right edge (e.g. the MOVE MIX tile in a single
  // column). max-width clamps the WIDTH, never the position - so we measure the
  // rendered bubble after open and nudge it back inside an 8px margin.
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [nudge, setNudge] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setNudge(0);
      return;
    }
    const measure = () => {
      const el = bubbleRef.current;
      if (!el) return;
      // Reset the correction first so the raw centered rect is measured.
      el.style.transform = "translateX(-50%)";
      const rect = el.getBoundingClientRect();
      const margin = 8;
      let dx = 0;
      if (rect.left < margin) dx = margin - rect.left;
      else if (rect.right > window.innerWidth - margin)
        dx = window.innerWidth - margin - rect.right;
      setNudge(dx);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  return (
    <span className="relative inline-block" data-infotip>
      <button
        type="button"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        className="flex h-4 w-4 items-center justify-center rounded-full bg-brandblue-soft text-[9px] font-extrabold text-brandblue"
      >
        i
      </button>
      {open && (
        <div
          ref={bubbleRef}
          style={{ transform: `translateX(calc(-50% + ${nudge}px))` }}
          className="absolute left-1/2 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border-2 border-brandblue bg-card p-2.5 text-left text-[11px] shadow-xl"
        >
          <div className="font-extrabold text-strong">{label}</div>
          <div className="mt-1 font-normal leading-relaxed text-soft">{what}</div>
          {drift && <div className="mt-1.5 font-bold text-savings">↳ {drift}</div>}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (ctx) ctx.setOpenId(null);
              else setLocalOpen(false);
            }}
            className="mt-1.5 text-[10px] font-extrabold text-brandblue"
          >
            Close
          </button>
        </div>
      )}
    </span>
  );
}
