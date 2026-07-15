"use client";

import { useMemo } from "react";
import type { EdgeSpec, GraphSpec, NodeSpec } from "@/lib/graph/types";

// A phone-first, readable view of the pipeline: agents grouped by their role in
// the flow, each tappable to edit, with the moves (edges) leaving it listed
// underneath in plain language. Far easier to scan and edit on a small screen
// than the SVG canvas (which stays available as the "Graph" view).
const GROUPS: { title: string; kinds: string[] }[] = [
  { title: "👂 Sense - understand the reply", kinds: ["entry", "transcribe", "extract", "media-coherence", "comparator"] },
  { title: "🧠 Decide - the chief", kinds: ["director"] },
  { title: "💬 Act - compose the move", kinds: ["answer", "clarify", "bargain", "deposit-probe", "fulfillment-probe", "present", "close", "pickup-location", "closing-message", "silent", "custom-llm"] },
  { title: "🛡️ Deliver - safety & send", kinds: ["style-validator", "localize", "safety", "deliver"] },
];

export function GraphList({
  spec,
  runCounts,
  onNode,
  onEdge,
}: {
  spec: GraphSpec;
  runCounts?: Record<string, number>;
  onNode: (n: NodeSpec) => void;
  onEdge: (e: EdgeSpec) => void;
}) {
  const nodeLabel = useMemo(
    () => (id: string) => spec.nodes.find((n) => n.id === id)?.label.split(" - ")[0] ?? id,
    [spec.nodes]
  );
  const edgesFrom = useMemo(() => {
    const m = new Map<string, EdgeSpec[]>();
    for (const e of spec.edges) {
      if (!m.has(e.from)) m.set(e.from, []);
      m.get(e.from)!.push(e);
    }
    for (const list of m.values()) list.sort((a, b) => a.priority - b.priority);
    return m;
  }, [spec.edges]);

  return (
    <div className="space-y-4">
      {GROUPS.map((g) => {
        const nodes = spec.nodes.filter((n) => g.kinds.includes(n.kind));
        if (nodes.length === 0) return null;
        return (
          <div key={g.title}>
            <div className="mb-1.5 text-[12px] font-extrabold text-soft">{g.title}</div>
            <div className="space-y-2">
              {nodes.map((n) => {
                const outs = edgesFrom.get(n.id) ?? [];
                const runs = runCounts?.[n.id];
                return (
                  <div key={n.id} className="rounded-2xl border border-line bg-card">
                    <button
                      onClick={() => onNode(n)}
                      className="btn flex w-full items-center gap-2 p-3 text-left"
                    >
                      <span className="text-xl leading-none">{n.emoji ?? "•"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-extrabold text-strong">
                          {n.label.split(" - ")[0]}
                        </span>
                        {n.instructions ? (
                          <span className="block truncate text-[11px] text-faint">
                            {n.instructions}
                          </span>
                        ) : (
                          <span className="block text-[11px] italic text-faint">tap to add a prompt</span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={`block text-[10px] font-bold ${
                            n.enabled ? "text-savings" : "text-brandred"
                          }`}
                        >
                          {n.enabled ? "on" : "off"}
                        </span>
                        {runs != null && runs > 0 && (
                          <span className="text-[10px] text-faint">{runs}×</span>
                        )}
                      </span>
                    </button>
                    {outs.length > 0 && (
                      <div className="border-t border-line px-3 pb-2 pt-1.5">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-faint">
                          Moves from here
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {outs.map((e) => (
                            <button
                              key={e.id}
                              onClick={() => onEdge(e)}
                              className={`btn btn-sm rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                                e.enabled
                                  ? "border-line text-soft hover:border-brandblue"
                                  : "border-dashed border-line text-faint"
                              }`}
                              title={`${e.label ?? e.id} -> ${nodeLabel(e.to)}`}
                            >
                              {e.label ? `${e.label} ` : ""}→ {nodeLabel(e.to)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
