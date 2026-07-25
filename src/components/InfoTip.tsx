"use client";

// Tap-to-open "i" info popup, lifted from the WA-security policy help pattern in
// admin/page.tsx into a reusable single-open widget. Every engine metric gets an
// InfoTip that explains, in plain language, WHAT the number means and WHAT TO DO
// if it drifts. Only one popup is open at a time (a shared context tracks the
// open id) so the panel never fills with stacked bubbles. Mobile-first: the
// bubble clamps to the viewport width and closes on outside tap or Escape.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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
        <div className="absolute left-1/2 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border-2 border-brandblue bg-card p-2.5 text-left text-[11px] shadow-xl">
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
