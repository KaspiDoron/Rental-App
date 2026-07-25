"use client";

// Tier-2 hand-rolled charts (no chart library) for the Engine section, using the
// div-meter idiom from ops/AnalyticsPanel. Two shapes: vertical hourly bars for
// throughput, and horizontal labelled meters for the move / provider mix.

import { InfoTip } from "@/components/InfoTip";
import { ENGINE_HELP } from "./help";

function SectionHead({ helpId }: { helpId: string }) {
  const h = ENGINE_HELP[helpId];
  return (
    <div className="mb-2 flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
      <span>{h?.label ?? helpId}</span>
      {h && <InfoTip id={`tip-${helpId}`} label={h.label} what={h.what} drift={h.drift} />}
    </div>
  );
}

/** Vertical bars, oldest hour on the left, current hour on the right. */
export function HourlyBars({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const n = data.length;
  return (
    <div className="surface rounded-2xl p-3">
      <SectionHead helpId="turnsPerHour" />
      <div className="flex items-end gap-1.5" style={{ height: 72 }}>
        {data.map((v, i) => {
          const isNow = i === n - 1;
          return (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[9px] font-bold text-faint">{v}</span>
              <div
                className={`w-full rounded-t ${isNow ? "bg-brandblue" : "bg-brandblue-soft"}`}
                style={{ height: `${Math.max(2, Math.round((v / max) * 52))}px` }}
              />
              <span className="text-[9px] font-bold text-faint">{isNow ? "now" : `-${n - 1 - i}h`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Horizontal labelled meters for a {key,count}[] distribution. */
export function MixBars({
  helpId,
  data,
  tone = "blue",
}: {
  helpId: string;
  data: { key: string; count: number }[];
  tone?: "blue" | "green";
}) {
  const total = data.reduce((a, c) => a + c.count, 0);
  const max = Math.max(1, ...data.map((d) => d.count));
  const color = tone === "green" ? "bg-savings" : "bg-brandblue";
  return (
    <div className="surface rounded-2xl p-3">
      <SectionHead helpId={helpId} />
      {data.length === 0 ? (
        <div className="text-[12px] text-soft">No data in the last 6h.</div>
      ) : (
        <div className="space-y-1.5">
          {data.map((d) => {
            const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
            return (
              <div key={d.key} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-[11px] font-bold text-soft" title={d.key}>
                  {d.key}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
                  <div className={`h-full ${color}`} style={{ width: `${Math.round((d.count / max) * 100)}%` }} />
                </div>
                <span className="w-14 shrink-0 text-right text-[10px] font-extrabold text-faint">
                  {d.count} · {pct}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
