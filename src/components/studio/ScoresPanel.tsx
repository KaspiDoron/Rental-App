"use client";

import { useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

interface Tactic {
  id: string;
  label: string;
  uses: number;
  wins: number;
  avgDiscountPct: number;
}
interface ScoreRow {
  thread_key: string;
  node_id: string;
  scorer: string;
  scores: Record<string, number>;
  verdict: string;
  created_at: string;
}

// The judge team's output: the per-tactic learning table (fed by the chief
// judge's outcome math via EMA) and the most recent move/chief scores.
export function ScoresPanel() {
  const [tactics, setTactics] = useState<Tactic[]>([]);
  const [recent, setRecent] = useState<ScoreRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/graph/scores")
      .then((r) => r.json())
      .then((d) => {
        setTactics(d.tactics ?? []);
        setRecent(d.recent ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingDots label="Loading scores" />;

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-[12px] font-extrabold text-strong">🎯 Tactic learning (self-improving)</div>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-card2 text-faint">
              <tr>
                <th className="p-2">Tactic</th>
                <th className="p-2">Uses</th>
                <th className="p-2">Win rate</th>
                <th className="p-2">Avg discount</th>
              </tr>
            </thead>
            <tbody>
              {tactics.map((t) => (
                <tr key={t.id} className="border-t border-line">
                  <td className="p-2 font-bold text-strong">{t.label}</td>
                  <td className="p-2 text-soft">{t.uses}</td>
                  <td className="p-2 text-soft">{t.uses ? Math.round((t.wins / t.uses) * 100) : 0}%</td>
                  <td className="p-2 text-soft">{t.avgDiscountPct}%</td>
                </tr>
              ))}
              {tactics.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-3 text-center text-faint">
                    No tactic outcomes yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[12px] font-extrabold text-strong">🏅 Recent judgments</div>
        {recent.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-line p-4 text-center text-[12px] text-faint">
            No judgments yet - they appear ~90s after each outbound message.
          </div>
        ) : (
          <div className="space-y-1.5">
            {recent.map((r, i) => (
              <div key={i} className="rounded-xl border border-line bg-card p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-card2 px-1.5 font-bold text-strong">{r.scorer}</span>
                  <span className="text-faint">{r.node_id}</span>
                  {Object.entries(r.scores ?? {}).map(([k, v]) => (
                    <span key={k} className="rounded-full bg-brandblue-soft px-1.5 text-brandblue">
                      {k} {v}
                    </span>
                  ))}
                </div>
                <div className="mt-0.5 text-soft">{r.verdict}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
