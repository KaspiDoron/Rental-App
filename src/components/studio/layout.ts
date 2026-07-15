// Layered (Sugiyama-lite) layout for the Pipeline Studio digraph. Pure, no
// dependencies - the graph is small (~20 nodes) so a longest-path layering plus
// one barycenter ordering pass is plenty, and it stays a tiny bundle vs a
// heavy graph library. On mobile the flow runs top-to-bottom (portrait), on
// wider screens left-to-right.

import type { GraphSpec } from "@/lib/graph/types";

export interface LaidOutNode {
  id: string;
  layer: number;
  index: number; // position within the layer
  x: number;
  y: number;
}
export interface Layout {
  nodes: Map<string, LaidOutNode>;
  width: number;
  height: number;
  layers: number;
}

const NODE_W = 150;
const NODE_H = 54;

export function layoutGraph(spec: GraphSpec, vertical: boolean): Layout {
  const ids = spec.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const outAdj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const id of ids) {
    outAdj.set(id, []);
    inDeg.set(id, 0);
  }
  // "inbound" is the virtual entry; treat edges from it as roots.
  const enabledEdges = spec.edges.filter((e) => e.enabled !== false);
  for (const e of enabledEdges) {
    if (!idSet.has(e.to)) continue;
    if (e.from === "inbound") continue; // virtual source
    if (!idSet.has(e.from)) continue;
    outAdj.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }

  // Longest-path layering from roots (nodes with no real in-edges, plus the
  // targets of inbound edges). BFS relaxation; cycles are broken by the visited
  // guard so a back-edge (present -> director) never loops forever.
  const layer = new Map<string, number>();
  for (const id of ids) layer.set(id, 0);
  const roots = ids.filter(
    (id) =>
      inDeg.get(id) === 0 ||
      enabledEdges.some((e) => e.from === "inbound" && e.to === id)
  );
  const queue = [...new Set(roots.length ? roots : ids.slice(0, 1))];
  const seen = new Set<string>();
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const id = queue.shift()!;
    const base = layer.get(id) ?? 0;
    for (const to of outAdj.get(id) ?? []) {
      if (to === id) continue;
      if ((layer.get(to) ?? 0) < base + 1) {
        layer.set(to, base + 1);
        if (!seen.has(`${to}:${base + 1}`)) {
          seen.add(`${to}:${base + 1}`);
          queue.push(to);
        }
      }
    }
  }

  // Bucket into layers.
  const maxLayer = Math.max(0, ...ids.map((id) => layer.get(id) ?? 0));
  const buckets: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) buckets[layer.get(id) ?? 0].push(id);

  // One barycenter ordering pass: order each layer by the average position of
  // its predecessors in the previous layer (reduces edge crossings).
  const pos = new Map<string, number>();
  buckets[0].forEach((id, i) => pos.set(id, i));
  for (let L = 1; L < buckets.length; L++) {
    const prevPos = (id: string) => pos.get(id) ?? 0;
    buckets[L].sort((a, b) => {
      const pa = enabledEdges.filter((e) => e.to === a).map((e) => prevPos(e.from));
      const pb = enabledEdges.filter((e) => e.to === b).map((e) => prevPos(e.from));
      const ba = pa.length ? pa.reduce((s, x) => s + x, 0) / pa.length : 0;
      const bb = pb.length ? pb.reduce((s, x) => s + x, 0) / pb.length : 0;
      return ba - bb;
    });
    buckets[L].forEach((id, i) => pos.set(id, i));
  }

  const gapMain = vertical ? 110 : 210; // between layers
  const gapCross = vertical ? 170 : 78; // within a layer
  const nodes = new Map<string, LaidOutNode>();
  let maxCross = 0;
  for (let L = 0; L < buckets.length; L++) {
    buckets[L].forEach((id, i) => {
      const x = vertical ? i * gapCross + 20 : L * gapMain + 20;
      const y = vertical ? L * gapMain + 20 : i * gapCross + 20;
      nodes.set(id, { id, layer: L, index: i, x, y });
      maxCross = Math.max(maxCross, i);
    });
  }
  const width = vertical
    ? (maxCross + 1) * gapCross + NODE_W
    : buckets.length * gapMain + NODE_W;
  const height = vertical
    ? buckets.length * gapMain + NODE_H
    : (maxCross + 1) * gapCross + NODE_H;

  return { nodes, width, height, layers: buckets.length };
}

export const STUDIO_NODE_W = NODE_W;
export const STUDIO_NODE_H = NODE_H;
