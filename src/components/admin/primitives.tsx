"use client";

// THE FAIL-DARK PRIMITIVES, SHARED (owner report 3, 3.5).
//
// The dash-not-zero contract (`Num`), the "these figures are incomplete"
// strip (`DegradedBanner`) and the every-KPI-explains-itself tile
// (`StatTile`) were each retrofitted onto ONE surface - LifecyclePanel got
// the first two, the Engine tab got the third - and never propagated, so the
// Command tab could still render a confident zero over an outage while the
// tab next to it knew better. One module, imported everywhere, so the
// discipline cannot drift per surface again.

import { InfoTip } from "@/components/InfoTip";

/** A number that might not be knowable. Dash, never zero. */
export function Num({ v, suffix }: { v: number | null | undefined; suffix?: string }) {
  if (v === null || v === undefined) {
    return (
      <span className="text-faint" title="Could not be read">
        &mdash;
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {v.toLocaleString()}
      {suffix}
    </span>
  );
}

/**
 * The one honest sentence about a partial read. Rendered ABOVE the figures it
 * qualifies, because a metric whose source failed is not zero and the reader
 * must know that before the numbers, not after.
 */
export function DegradedBanner({ degraded }: { degraded: readonly string[] | undefined | null }) {
  if (!degraded || degraded.length === 0) return null;
  return (
    <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3 text-[12px] font-extrabold text-brandred">
      Some figures could not be read: {degraded.join(", ")}. Anything shown as &mdash; is unknown,
      not zero.
    </div>
  );
}

export interface StatHelp {
  label: string;
  what: string;
  drift?: string;
}

/**
 * A KPI tile that CANNOT ship without its explanation. The generic parameter
 * ties `helpId` to the catalogue the caller passes, so adding a tile without
 * adding its help entry is a TYPE error, not a review comment - the "i on
 * every KPI" rule, enforced where it cannot be forgotten.
 */
export function StatTile<H extends Record<string, StatHelp>>({
  help,
  helpId,
  value,
  emoji,
  tone,
  sub,
}: {
  help: H;
  helpId: keyof H & string;
  /** null/undefined renders the dash - the fail-dark contract, not zero. */
  value: number | string | null | undefined;
  emoji?: string;
  tone?: string;
  sub?: string;
}) {
  const h = help[helpId];
  return (
    <div className="surface rounded-2xl p-3 text-center">
      <div className={`text-xl font-extrabold ${tone ?? "text-strong"}`}>
        {emoji ? `${emoji} ` : ""}
        {typeof value === "string" ? value : <Num v={value} />}
      </div>
      <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-faint">
        <span>{h.label}</span>
        <InfoTip id={`tip-${helpId}`} label={h.label} what={h.what} drift={h.drift} />
      </div>
      {sub && <div className="mt-0.5 text-[10px] font-bold text-faint">{sub}</div>}
    </div>
  );
}
