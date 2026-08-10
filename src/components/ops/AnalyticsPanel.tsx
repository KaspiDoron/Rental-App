"use client";

// Negotiation-quality analytics: which branches win, whether the latest
// behavior revision regressed, how quality trends week over week, how the
// judge's standards compare with the owner's, and which failure patterns
// dominate. Hand-rolled meter bars, design tokens only.

import { useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

interface HeatRow {
  edge: string;
  uses: number;
  ownerCorrectPct: number | null;
  verdicts: number;
  improved: number;
  worsened: number;
  avgRating: number | null;
}
interface RevRow {
  rev: number;
  decisions: number;
  avgOutcome: number | null;
  avgTone: number | null;
  avgTacticFit: number | null;
}
interface WeekRow {
  week: string;
  avgTone: number | null;
  avgTacticFit: number | null;
  avgOutcome: number | null;
  avgOwnerRating: number | null;
  samples: number;
}

interface Analytics {
  days: number;
  activeRev: number | null;
  heatmap: HeatRow[];
  revisions: RevRow[];
  regression: string | null;
  timeline: WeekRow[];
  calibration: { owner: number; judge: number }[];
  tags: { tag: string; count: number }[];
  // NULL MEANS UNREAD, not zero. The route stopped catching a failed read into
  // an empty array, so the panel has to be able to say "we could not look".
  totals: {
    decisionsTraced: number | null;
    judgeScores: number | null;
    ownerReviews: number | null;
  };
  /** Inputs that could not be read this load. Empty on a healthy page. */
  degraded?: string[];
}

function Meter({ value, max, tone = "blue" }: { value: number; max: number; tone?: "blue" | "green" | "red" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color = tone === "green" ? "bg-savings" : tone === "red" ? "bg-brandred" : "bg-brandblue";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function AnalyticsPanel() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/admin/ops/analytics?days=30")
      .then((r) => r.json())
      .then((d) => (d?.heatmap ? setData(d) : setError(true)))
      .catch(() => setError(true));
  }, []);

  if (error) {
    return <div className="surface rounded-blob p-4 text-[12px] text-brandred">Analytics failed to load.</div>;
  }
  if (!data) return <LoadingDots label="Crunching negotiation quality" />;

  const degraded = data.degraded ?? [];

  const maxUses = Math.max(1, ...data.heatmap.map((h) => h.uses));
  const maxTag = Math.max(1, ...data.tags.map((t) => t.count));

  // 5x5 calibration matrix counts.
  const matrix: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const c of data.calibration) {
    const o = Math.min(5, Math.max(1, Math.round(c.owner))) - 1;
    const j = Math.min(5, Math.max(1, Math.round(c.judge))) - 1;
    matrix[o][j]++;
  }
  const maxCell = Math.max(1, ...matrix.flat());

  return (
    <div className="space-y-3">
      {/* M21 - THE DARK STRIP RENDERS FIRST.
          If an input could not be read, every figure below it is unverified,
          and the page says so before it shows a single number. Silently
          rendering zeros is the failure this repo has shipped three times:
          the Command Center's nine catches, "Messaging: All good" over a dead
          webhook, and classifySafety answering from positive evidence only. */}
      {degraded.length > 0 && (
        <div className="surface rounded-blob border-2 border-amber-500/40 p-3.5">
          <p className="text-[12px] font-extrabold text-amber-400">
            Some figures could not be read
          </p>
          <p className="mt-0.5 text-[11px] text-soft">
            Unavailable: {degraded.join(", ")}. Anything below that depends on
            them is missing, not zero - treat this page as incomplete until the
            database read succeeds.
          </p>
        </div>
      )}

      {data.regression && (
        <div className="surface rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3.5">
          <p className="text-[12px] font-extrabold text-brandred">⚠️ Possible regression</p>
          <p className="mt-0.5 text-[11px] text-brandred">{data.regression}</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["Decisions", data.totals.decisionsTraced],
            ["Judge scores", data.totals.judgeScores],
            ["Your reviews", data.totals.ownerReviews],
          ] as const
        ).map(([label, v]) => (
          <div key={label} className="surface rounded-2xl p-3 text-center">
            {/* A dash, never a zero. */}
            <p className="tabular text-[18px] font-extrabold text-strong">
              {v === null ? <span className="text-faint" title="Could not be read">&mdash;</span> : v}
            </p>
            <p className="text-[9px] font-extrabold uppercase tracking-wide text-faint">{label}</p>
          </div>
        ))}
      </div>

      {/* Branch heatmap */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">🔥 Branch effectiveness</h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Every director edge that fired in the last {data.days} days, with your verdicts.
          Low owner-correct% on a busy edge = the first thing to coach.
        </p>
        {data.heatmap.length === 0 && (
          <p className="mt-2 text-[11px] text-faint">No traced decisions in this window yet.</p>
        )}
        <div className="mt-2 space-y-1.5">
          {data.heatmap.map((h) => (
            <div key={h.edge} className="rounded-xl bg-card2 px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 truncate font-extrabold text-strong">{h.edge}</span>
                <span className="ml-auto shrink-0 text-faint">{h.uses}x</span>
                {h.ownerCorrectPct != null && (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-extrabold ${
                      h.ownerCorrectPct >= 70
                        ? "bg-savings-soft text-savings"
                        : "bg-brandred-soft text-brandred"
                    }`}
                  >
                    {h.ownerCorrectPct}% correct ({h.verdicts})
                  </span>
                )}
                {h.avgRating != null && <span className="shrink-0 text-soft">⭐ {h.avgRating}</span>}
                {h.improved > 0 && <span className="shrink-0 text-savings">+{h.improved}</span>}
                {h.worsened > 0 && <span className="shrink-0 text-brandred">-{h.worsened}</span>}
              </div>
              <div className="mt-1">
                <Meter value={h.uses} max={maxUses} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quality by behavior revision */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">📈 Quality by behavior revision</h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Every decision is stamped with the policy version that produced it - a drop after a
          change is visible here (active: rev {data.activeRev ?? "-"}).
        </p>
        <div className="mt-2 space-y-1.5">
          {data.revisions.length === 0 && (
            <p className="text-[11px] text-faint">No scored decisions yet.</p>
          )}
          {data.revisions.map((r) => (
            <div key={r.rev} className="flex items-center gap-2 rounded-xl bg-card2 px-2.5 py-1.5 text-[11px]">
              <span className={`font-extrabold ${r.rev === data.activeRev ? "text-brandblue" : "text-strong"}`}>
                rev {r.rev === 0 ? "pre-versioning" : r.rev}
                {r.rev === data.activeRev ? " (active)" : ""}
              </span>
              <span className="ml-auto text-soft">outcome {r.avgOutcome ?? "-"}</span>
              <span className="text-soft">tone {r.avgTone ?? "-"}</span>
              <span className="text-soft">fit {r.avgTacticFit ?? "-"}</span>
              <span className="text-faint">{r.decisions} scored</span>
            </div>
          ))}
        </div>

        {data.timeline.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-extrabold uppercase tracking-wide text-faint">
              Weekly trend (outcome 1-5)
            </p>
            <div className="mt-1 space-y-1">
              {data.timeline.map((w) => (
                <div key={w.week} className="flex items-center gap-2 text-[10px]">
                  <span className="w-16 shrink-0 text-faint">{w.week.slice(5)}</span>
                  <div className="min-w-0 flex-1">
                    <Meter value={w.avgOutcome ?? w.avgOwnerRating ?? 0} max={5} tone="green" />
                  </div>
                  <span className="w-8 shrink-0 text-right font-bold text-soft">
                    {w.avgOutcome ?? w.avgOwnerRating ?? "-"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Calibration matrix */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">🎯 You vs the judge</h4>
        <p className="mt-0.5 text-[11px] text-soft">
          Your rating (rows) against the judge's tacticFit (columns) on the same decisions.
          Mass off the diagonal = the judge needs calibrating - your low ratings with feedback
          re-anchor it automatically.
        </p>
        {data.calibration.length === 0 ? (
          <p className="mt-2 text-[11px] text-faint">
            Rate a few decisions that the judge also scored and the matrix fills in.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="tabular text-center text-[10px]">
              <thead>
                <tr>
                  <th className="p-1 text-faint">you \ judge</th>
                  {[1, 2, 3, 4, 5].map((j) => (
                    <th key={j} className="p-1 font-extrabold text-soft">{j}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row, o) => (
                  <tr key={o}>
                    <td className="p-1 font-extrabold text-soft">{o + 1}</td>
                    {row.map((n, j) => (
                      <td key={j} className="p-0.5">
                        <div
                          className={`flex h-7 w-9 items-center justify-center rounded-md text-[10px] font-bold ${
                            n === 0 ? "bg-card2 text-faint" : "text-strong"
                          }`}
                          style={
                            n > 0
                              ? { backgroundColor: `color-mix(in srgb, var(--blue) ${20 + (n / maxCell) * 60}%, transparent)` }
                              : undefined
                          }
                        >
                          {n || ""}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Failure tags */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="text-[13px] font-extrabold text-strong">🏷️ Failure patterns</h4>
        {data.tags.length === 0 ? (
          <p className="mt-1 text-[11px] text-faint">Tag reviews (missed-leverage, tone, extraction...) and patterns emerge here.</p>
        ) : (
          <div className="mt-2 space-y-1">
            {data.tags.map((t) => (
              <div key={t.tag} className="flex items-center gap-2 text-[11px]">
                <span className="w-32 shrink-0 truncate font-bold text-strong">{t.tag}</span>
                <div className="min-w-0 flex-1">
                  <Meter value={t.count} max={maxTag} tone="red" />
                </div>
                <span className="w-6 shrink-0 text-right text-soft">{t.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
