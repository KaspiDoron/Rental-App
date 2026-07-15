"use client";

import { useMemo, useState } from "react";
import type { EdgeSpec, GraphSpec, NodeSpec } from "@/lib/graph/types";
import { layoutGraph, STUDIO_NODE_H, STUDIO_NODE_W } from "./layout";

// A pure-SVG digraph: nodes are rounded rects (emoji + label + on/off + run
// count), edges are beziers with an arrowhead and a tappable condition chip.
// A replay `path` (ordered node ids) highlights the traversed route with step
// numbers and dims the rest - this is the "what you see is how it runs" view.
export function GraphCanvas({
  spec,
  vertical,
  runCounts,
  path,
  onNode,
  onEdge,
  selectedNode,
}: {
  spec: GraphSpec;
  vertical: boolean;
  runCounts?: Record<string, number>;
  path?: string[];
  onNode?: (n: NodeSpec) => void;
  onEdge?: (e: EdgeSpec) => void;
  selectedNode?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const layout = useMemo(() => layoutGraph(spec, vertical), [spec, vertical]);
  const nodesById = useMemo(() => new Map(spec.nodes.map((n) => [n.id, n])), [spec.nodes]);

  const pathSet = useMemo(() => new Set(path ?? []), [path]);
  const pathEdges = useMemo(() => {
    // Highlight an edge when its from->to are consecutive in the path.
    const set = new Set<string>();
    if (!path || path.length < 2) return set;
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      const edge = spec.edges.find((e) => e.from === from && e.to === to && e.enabled);
      if (edge) set.add(edge.id);
    }
    // Also the director->act edge stamped on traces (edge id in the path stages
    // is handled by the parent passing edge ids; keep this heuristic as backup).
    return set;
  }, [path, spec.edges]);

  const stepOf = (id: string) => (path ? path.indexOf(id) : -1);

  return (
    <div className="rounded-2xl border-2 border-line bg-card2 p-2">
      <div className="mb-2 flex items-center justify-end gap-2">
        <button
          onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}
          className="btn btn-sm btn-ghost h-8 w-8 rounded-lg border border-line text-lg"
          aria-label="Zoom out"
        >
          -
        </button>
        <span className="text-[11px] text-faint">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.15).toFixed(2))))}
          className="btn btn-sm btn-ghost h-8 w-8 rounded-lg border border-line text-lg"
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto no-scrollbar">
        <svg
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ minWidth: layout.width * zoom }}
        >
          <defs>
            <marker id="wd-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--blue)" />
            </marker>
            <marker id="wd-arrow-dim" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--line)" />
            </marker>
          </defs>

          {/* edges */}
          {spec.edges
            .filter((e) => e.enabled && nodesById.has(e.to) && nodesById.has(e.from))
            .map((e, i) => {
              const from = layout.nodes.get(e.from);
              const to = layout.nodes.get(e.to);
              if (!to || !from) return null;
              const backward = to.layer <= from.layer; // e.g. present -> director
              const sx = from.x + STUDIO_NODE_W / 2;
              const sy = from.y + STUDIO_NODE_H;
              const tx = to.x + STUDIO_NODE_W / 2;
              const ty = to.y;
              const midY = (sy + ty) / 2;
              const inPath = pathEdges.has(e.id);
              const dim = path && path.length > 0 && !inPath;
              // A backward/side edge bows out to the side so it never runs
              // straight through the nodes stacked between its endpoints.
              const bow = backward ? (i % 2 ? 70 : -70) : 0;
              const d = backward
                ? `M ${sx} ${sy} C ${sx + bow} ${midY}, ${tx + bow} ${midY}, ${tx} ${ty}`
                : `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
              const mx = (sx + tx) / 2 + bow / 2;
              const my = midY;
              return (
                <g key={e.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke={inPath ? "var(--blue)" : "var(--line)"}
                    strokeWidth={inPath ? 3 : 1.5}
                    strokeOpacity={dim ? 0.25 : backward ? 0.5 : 0.9}
                    strokeDasharray={backward ? "5 4" : undefined}
                    markerEnd={`url(#${dim ? "wd-arrow-dim" : "wd-arrow"})`}
                  />
                  {onEdge && !dim && (
                    <foreignObject x={mx - 11} y={my - 11} width={22} height={22}>
                      <button
                        onClick={() => onEdge(e)}
                        title={e.label}
                        aria-label={`Edit edge: ${e.label ?? e.id}`}
                        className="pointer-events-auto flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line bg-card text-[10px] text-soft hover:border-brandblue"
                      >
                        ✎
                      </button>
                    </foreignObject>
                  )}
                </g>
              );
            })}

          {/* nodes */}
          {spec.nodes.map((n) => {
            const p = layout.nodes.get(n.id);
            if (!p) return null;
            const step = stepOf(n.id);
            const inPath = pathSet.has(n.id);
            const dim = path && path.length > 0 && !inPath;
            const runs = runCounts?.[n.id];
            const selected = selectedNode === n.id;
            return (
              <foreignObject key={n.id} x={p.x} y={p.y} width={STUDIO_NODE_W} height={STUDIO_NODE_H}>
                <button
                  onClick={() => onNode?.(n)}
                  className={`flex h-full w-full items-center gap-1.5 rounded-xl border-2 px-2 text-left transition ${
                    selected
                      ? "border-brandblue bg-brandblue-soft"
                      : inPath
                      ? "border-brandblue bg-card"
                      : n.enabled
                      ? "border-line bg-card"
                      : "border-dashed border-line bg-card2"
                  }`}
                  style={{ opacity: dim ? 0.4 : 1 }}
                >
                  <span className="text-lg leading-none">{n.emoji ?? "•"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-extrabold text-strong">
                      {n.label.split(" - ")[0]}
                    </span>
                    <span className="flex items-center gap-1 text-[9px] text-faint">
                      {n.enabled ? (
                        <span className="text-savings">on</span>
                      ) : (
                        <span className="text-brandred">off</span>
                      )}
                      {runs != null && runs > 0 && <span>· {runs}×</span>}
                    </span>
                  </span>
                  {step >= 0 && (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brandblue text-[10px] font-extrabold text-white">
                      {step + 1}
                    </span>
                  )}
                </button>
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
