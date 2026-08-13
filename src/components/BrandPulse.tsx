"use client";

// THE LOADER: A WHEELDEAL HEARTBEAT INSIDE THE HUE BLOOM, ON A BLURRED BACKDROP.
//
// The owner asked for exactly this - "an animation heartbeat of the WheelDeal
// logo, and the background is blurry" - and for the hue to keep its colours
// while picking up the brand. Three parts, each doing one job:
//
//   the veil     `.wd-loader-veil` - a blurred, translucent backdrop, so the
//                app reads as still there and out of focus rather than replaced
//                by a loading screen. Suspension, not substitution.
//   the bloom    `.aurora` - the same primitive every skeleton wears, so there
//                is ONE visual answer to "something is happening" in this app
//                instead of a different one per surface. It breathes on the
//                same period the heart beats on, so they read as one organism.
//   the heart    the real BrandMark SVG on `.wd-heartbeat` - a lub-dub with two
//                unequal contractions and a long diastole, not a symmetric
//                pulse. See the keyframes for why the pause is the point.
//
// NO ANIMATION LIBRARY. Motion is ~12 KB gzipped and Framer Motion ~31 KB, and
// every effect here is a keyframe over an SVG that is already in the bundle.
// For travellers on roaming data, on free-tier Cloud Run, paying that for a
// loading screen would be the wrong trade twice over - and a JS-driven glow on
// a loading screen competes for the main thread with the very work being waited
// on. The whole thing is CSS; aurora.test.ts forbids JS timers in this module
// and that rule now covers this file too.

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
      className={`flex flex-col items-center gap-2.5 ${className}`}
    >
      {/* The bloom is on a wrapper rather than on the SVG: `.aurora` composes a
          rim onto its own box, and a rim traced around a scooter silhouette is
          not what anyone wants. A round wrapper gives the light something to
          travel along. */}
      <span
        className="aurora relative inline-flex items-center justify-center rounded-full"
        style={{ width: size * 1.28, height: size * 1.28 }}
      >
        <BrandMark size={size} className="wd-heartbeat" />
      </span>
      {label && <span className="text-[12px] font-extrabold text-soft">{label}</span>}
    </div>
  );
}

/**
 * The full-screen version: the same heartbeat, centred on the blurred veil.
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
