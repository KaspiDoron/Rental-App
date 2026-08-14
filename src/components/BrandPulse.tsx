"use client";

// THE LOADER (Loading v3): A STILL WHEELDEAL MARK OVER A TRAVELLING HORIZON LINE.
//
// The owner's verdict on v2 was blunt - the outline mark, its heartbeat pulse
// and the five-hue "aurora" wheel behind it were "the worst thing that I ever
// seen". Every one of those is gone here. What premium/luxury loaders actually
// do in 2025-26 (Vercel, Linear, Stripe, skeleton-first product UIs) is the
// opposite of a throbbing logo: the brand mark holds PERFECTLY STILL and a
// single thin, single-hue bar carries all the motion. Two parts, each one job:
//
//   the mark      the REAL solid BrandMark - the brand's actual speaking voice,
//                 not a monoline sketch - rendered motionless. A scaling logo is
//                 the single most dated loading element and exactly what
//                 prefers-reduced-motion exists to suppress, so it never scales,
//                 pulses, or draws itself on. Stillness reads as confidence.
//   the horizon   `.wd-horizon` - a ~2px rounded bar under the mark on a faint
//                 track, with ONE bright specular segment gliding left -> right
//                 on a ~1.6s ease. One brand hue walked in oklch lightness -
//                 never a colour wheel. This is the loader's whole animation.
//
// NO ANIMATION LIBRARY. Motion is ~12 KB gz and Framer Motion ~31 KB; every
// effect here is a single CSS keyframe over an SVG already in the bundle. On
// roaming data, on free-tier Cloud Run, a JS-driven loading screen would also
// compete for the main thread with the very work being waited on. The whole
// thing is CSS; aurora.test.ts forbids JS timers in this module.

import { BrandMark } from "./BrandMark";

export function BrandPulse({
  size = 56,
  label,
  className = "",
}: {
  /** Mark diameter in px. */
  size?: number;
  /** Announced to screen readers and shown beneath the mark when present. */
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label || "Loading"}
      className={`flex flex-col items-center gap-3 ${className}`}
    >
      {/* The solid mark, held still. No wd-heartbeat, no outline, no wrapper
          glow - the motion lives entirely in the horizon line below. */}
      <BrandMark size={size} />
      {/* THE HORIZON LINE. Width tracks the mark (~2x) so it reads as a base the
          mark rests on. The single travelling glint is the status signal. */}
      <span className="wd-horizon" aria-hidden="true" style={{ width: Math.round(size * 2) }} />
      {label && <span className="text-[12px] font-extrabold text-soft">{label}</span>}
    </div>
  );
}

/**
 * The full-screen version: the same still mark + horizon, centred on a light
 * veil that lets the intensified ambient wash read through it.
 *
 * `fixed` + the veil rather than a solid panel, because a loading state that
 * paints over the app makes every wait feel like a navigation. Sitting at the
 * panel rung of the layer ladder keeps it above the page and below any dialog -
 * a loader that covers a dialog is the ThreadDashboard defect wearing a
 * different hat.
 */
export function BrandPulseVeil({
  label,
  size = 64,
  layer = "layer-panel",
}: {
  label?: string;
  size?: number;
  /** Ladder rung. NavVeil passes "layer-veil" - a NAVIGATION veil must sit
   *  above open dialogs (the page under them is leaving); everything else
   *  stays at panel, below dialogs. */
  layer?: "layer-panel" | "layer-veil";
}) {
  return (
    <div className={`wd-loader-veil ${layer} fixed inset-0 flex items-center justify-center px-6`}>
      <BrandPulse size={size} label={label} />
    </div>
  );
}
