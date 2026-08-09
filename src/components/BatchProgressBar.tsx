"use client";

import type { BatchProgress } from "@/lib/progress";
import { SEGMENT_ONE_PCT } from "@/lib/progress";

/**
 * THE TWO-SEGMENT BAR - plan Part 11 F4.
 *
 * This component RENDERS. It does not derive. Every number here arrives
 * pre-computed from `/api/activity`, on the same authoritative rung the cards
 * and counters read, because Part 5.5 found four live derivations of "shops
 * contacted" plus a dead fifth - and a bar that computed its own would be a
 * sixth, on the surface people watch hardest.
 *
 * The split is visible on purpose. Segment 1 (0-60%) is reaching shops;
 * segment 2 (60-100%) is collecting quotes, and it keeps moving long after the
 * last message has left. A single undifferentiated bar would let the user read
 * "dispatch finished" as "the work is done".
 */
export default function BatchProgressBar({
  progress,
  t,
  formatClock,
}: {
  progress: BatchProgress;
  t: (s: string) => string;
  formatClock: (iso: string) => string;
}) {
  const { pct, stall, reached, selected, quoted } = progress;
  // A stopped bar is a different visual, not just a stationary one. A bar that
  // merely stops moving is indistinguishable from a slow one, and the whole
  // point of the stop states is that the user learns something from them.
  const held = stall === "cold-held" || stall === "intro-budget";
  const seg1Width = selected > 0 ? Math.min(SEGMENT_ONE_PCT, (reached / selected) * SEGMENT_ONE_PCT) : 0;
  const seg2Width = Math.max(0, pct - seg1Width);

  // Whole sentence in, placeholders filled here - never a number glued to a
  // fragment, which is what breaks in Hebrew and RTL.
  let line = t(progress.label);
  for (const [k, v] of Object.entries(progress.vars)) {
    line = line.split(`{${k}}`).join(String(v));
  }

  return (
    <div className="rounded-xl bg-card2 px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-extrabold text-strong">
          {quoted > 0 ? `💰 ${t("Collecting quotes")}` : `📤 ${t("Reaching shops")}`}
        </span>
        <span className="shrink-0 text-[10px] font-bold text-soft" aria-hidden>
          {pct}%
        </span>
      </div>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={line}
      >
        <div
          className={`h-full transition-all ${held ? "bg-brandyellow" : "bg-brandblue"}`}
          style={{ width: `${seg1Width}%` }}
        />
        <div
          className="h-full bg-savings transition-all"
          style={{ width: `${seg2Width}%` }}
        />
      </div>
      <p className={`mt-1 text-[10px] ${held ? "font-bold text-[#8a6100] dark:text-brandyellow" : "text-faint"}`}>
        {held ? "⏸ " : ""}
        {line}
        {/* The ETA is the schedule's own number, or nothing. A batch runs about
            twenty minutes at free tier and up to an hour and a half at a full
            twenty-four shops, so there is no honest constant to fall back on. */}
        {!held && progress.etaDoneBy && reached < selected
          ? ` ${t("All reached by")} ~${formatClock(progress.etaDoneBy)}.`
          : ""}
      </p>
    </div>
  );
}
