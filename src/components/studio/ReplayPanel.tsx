"use client";

import { useEffect, useState } from "react";
import type { GraphSpec } from "@/lib/graph/types";
import { LoadingDots } from "../LoadingDots";

interface Stage {
  stage: string;
  nodeId?: string | null;
  edgeId?: string | null;
  input?: string | null;
  reasoning?: string | null;
  output?: string | null;
  verdict?: string | null;
}
interface Decision {
  decisionId: string;
  vendorName: string;
  userEmail: string;
  at: string;
  path: string[];
  stages: Stage[];
}
interface ScoreEntry {
  scores: Record<string, number>;
  verdict: string;
  scorer: string;
}

// Live replay: real inbound events grouped by decision, each replaying the
// EXACT node path it took through the graph. Selecting one animates the path
// on the canvas (via onPreviewPath) and shows every stage's in/why/out + the
// judge's score badge. This is the guarantee that the Studio shows how the
// real conversations run.
export function ReplayPanel({
  onPreviewPath,
  spec,
}: {
  onPreviewPath: (path: string[]) => void;
  spec: GraphSpec;
}) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [scores, setScores] = useState<Record<string, ScoreEntry>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const nodeLabel = (id?: string | null) =>
    (id && spec.nodes.find((n) => n.id === id)?.label.split(" - ")[0]) || id || "";

  useEffect(() => {
    fetch("/api/admin/graph/replay")
      .then((r) => r.json())
      .then((d) => {
        setDecisions(d.decisions ?? []);
        setScores(d.scores ?? {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingDots label="Loading real decisions" />;
  if (decisions.length === 0) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-line p-6 text-center text-[13px] text-faint">
        No live decisions yet. Once shops reply over WhatsApp, every decision the
        engine makes appears here with its exact graph path.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {decisions.map((d) => {
        const score = scores[d.decisionId];
        const isOpen = open === d.decisionId;
        return (
          <div key={d.decisionId} className="rounded-2xl border border-line bg-card">
            <button
              onClick={() => {
                setOpen(isOpen ? null : d.decisionId);
                if (!isOpen && d.path.length) onPreviewPath(d.path);
              }}
              className="btn flex w-full items-center gap-2 p-3 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-extrabold text-strong">
                  {d.vendorName || "Shop"}
                </span>
                <span className="block truncate text-[11px] text-faint">
                  {d.path.map(nodeLabel).join(" → ") || "no path"}
                </span>
              </span>
              {score && (
                <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-bold text-brandblue">
                  tone {score.scores.tone ?? "-"} · fit {score.scores.tacticFit ?? "-"}
                </span>
              )}
              <span className="text-faint">{isOpen ? "▲" : "▼"}</span>
            </button>
            {isOpen && (
              <div className="border-t border-line p-2">
                {d.path.length > 0 && (
                  <button
                    onClick={() => onPreviewPath(d.path)}
                    className="btn btn-sm mb-2 rounded-lg border border-line px-2.5 py-1 text-[11px] font-bold text-brandblue"
                  >
                    ▶ Show this path on the graph
                  </button>
                )}
                {score && (
                  <div className="mb-2 rounded-lg bg-card2 p-2 text-[11px] text-soft">
                    <span className="font-bold text-strong">Judge ({score.scorer}):</span> {score.verdict}
                  </div>
                )}
                <div className="space-y-1.5">
                  {d.stages.map((s, i) => (
                    <div key={i} className="rounded-lg border border-line bg-card2 p-2 text-[11px]">
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-strong">
                          {i + 1}. {nodeLabel(s.nodeId) || s.stage}
                        </span>
                        {s.verdict && <span className="rounded bg-card px-1.5 text-faint">{s.verdict}</span>}
                      </div>
                      {s.reasoning && <div className="text-soft"><span className="text-faint">why:</span> {s.reasoning}</div>}
                      {s.output && <div className="text-strong"><span className="text-faint">out:</span> {s.output}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
