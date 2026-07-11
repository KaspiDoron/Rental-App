"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// Owner-only negotiation-funnel editor (New#3/#10). Renders the if/else tree as
// a pannable "map" (drag with a finger/mouse) of connected nodes, each editable
// (condition + agent action), with add-branch, delete, and per-node AI
// suggestions. Auto-grown branches (from vague shop replies) are flagged.

interface Node {
  id: string;
  label: string;
  condition: string;
  message: string;
  auto?: boolean;
  children: Node[];
}

interface Positioned {
  node: Node;
  x: number;
  y: number;
  parent?: Positioned;
}

const NODE_W = 190;
const NODE_H = 96;
const H_GAP = 46;
const V_GAP = 40;

// Simple tidy tree layout: leaves get sequential slots, parents centre on kids.
function layout(root: Node): { nodes: Positioned[]; width: number; height: number } {
  const nodes: Positioned[] = [];
  let leafX = 0;
  const place = (node: Node, depth: number, parent?: Positioned): Positioned => {
    const y = depth * (NODE_H + V_GAP) + 20;
    let x: number;
    if (node.children.length === 0) {
      x = leafX * (NODE_W + H_GAP) + 20;
      leafX += 1;
    } else {
      const kids = node.children.map((c) => place(c, depth + 1));
      x = (kids[0].x + kids[kids.length - 1].x) / 2;
      const self: Positioned = { node, x, y, parent };
      nodes.push(self);
      kids.forEach((k) => (k.parent = self));
      return self;
    }
    const self: Positioned = { node, x, y, parent };
    nodes.push(self);
    return self;
  };
  place(root, 0);
  const maxX = Math.max(...nodes.map((n) => n.x), 0) + NODE_W + 40;
  const maxY = Math.max(...nodes.map((n) => n.y), 0) + NODE_H + 40;
  return { nodes, width: maxX, height: maxY };
}

function findAndMutate(root: Node, id: string, fn: (n: Node) => void): Node {
  const walk = (n: Node) => {
    if (n.id === id) fn(n);
    n.children.forEach(walk);
  };
  const clone: Node = JSON.parse(JSON.stringify(root));
  walk(clone);
  return clone;
}
function removeNode(root: Node, id: string): Node {
  const clone: Node = JSON.parse(JSON.stringify(root));
  const walk = (n: Node) => {
    n.children = n.children.filter((c) => c.id !== id);
    n.children.forEach(walk);
  };
  walk(clone);
  return clone;
}

export function FunnelEditor() {
  const [tree, setTree] = useState<Node | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState({ x: 10, y: 0, scale: 1 });
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  // Active pointers (id -> position) so one finger pans and two pinch-zoom.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<{
    startView: { x: number; y: number; scale: number };
    startMid: { x: number; y: number };
    startDist: number;
    moved: boolean;
  } | null>(null);

  const didFit = useRef(false);

  useEffect(() => {
    fetch("/api/admin/funnel")
      .then((r) => r.json())
      .then((d) => d.tree && setTree(d.tree))
      .catch(() => {});
  }, []);

  // Auto-fit the tree into view the first time it loads.
  useEffect(() => {
    if (!tree || didFit.current || !canvasRef.current) return;
    didFit.current = true;
    const { width, height } = layout(tree);
    const el = canvasRef.current;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const scale = Math.min(2, Math.max(0.3, Math.min(vw / (width + 20), vh / (height + 20), 1)));
    setView({ x: (vw - width * scale) / 2, y: 12, scale });
  }, [tree]);

  // Re-fit the tree whenever we enter/leave fullscreen (the canvas size changed).
  useEffect(() => {
    if (!tree || !canvasRef.current) return;
    const { width, height } = layout(tree);
    const el = canvasRef.current;
    // Defer one frame so the layout has settled at the new size.
    const id = requestAnimationFrame(() => {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      if (!vw || !vh) return;
      const scale = Math.min(2, Math.max(0.3, Math.min(vw / (width + 20), vh / (height + 20), 1)));
      setView({ x: (vw - width * scale) / 2, y: 12, scale });
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const save = useCallback(async (next: Node) => {
    setTree(next);
    setSaving(true);
    try {
      await fetch("/api/admin/funnel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tree: next }),
      });
    } finally {
      setSaving(false);
    }
  }, []);

  if (!tree) return <div className="p-4 text-[12px] text-faint">Loading funnel…</div>;

  const { nodes, width, height } = layout(tree);
  const selected = nodes.find((n) => n.node.id === sel)?.node ?? null;

  const clampScale = (s: number) => Math.min(2, Math.max(0.3, s));
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  // Fit the whole tree into the visible canvas (recenter + auto scale).
  const fit = () => {
    const el = canvasRef.current;
    if (!el) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const scale = clampScale(Math.min(vw / (width + 20), vh / (height + 20), 1));
    setView({ x: (vw - width * scale) / 2, y: 12, scale });
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    gesture.current = {
      startView: { ...view },
      startMid: pts.length >= 2 ? mid(pts[0], pts[1]) : { x: e.clientX, y: e.clientY },
      startDist: pts.length >= 2 ? dist(pts[0], pts[1]) : 0,
      moved: false,
    };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2) {
      // Pinch: scale around the midpoint, and pan by the midpoint delta.
      const m = mid(pts[0], pts[1]);
      const scale = clampScale((g.startView.scale * dist(pts[0], pts[1])) / (g.startDist || 1));
      const k = scale / g.startView.scale;
      setView({
        scale,
        x: m.x - (g.startMid.x - g.startView.x) * k,
        y: m.y - (g.startMid.y - g.startView.y) * k,
      });
      g.moved = true;
    } else {
      const dx = pts[0].x - g.startMid.x;
      const dy = pts[0].y - g.startMid.y;
      if (Math.hypot(dx, dy) > 4) g.moved = true;
      setView({ ...view, x: g.startView.x + dx, y: g.startView.y + dy });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      // If this gesture panned/zoomed, swallow the click that follows so a drag
      // never accidentally opens a node.
      if (gesture.current?.moved) {
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 60);
      }
      gesture.current = null;
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const scale = clampScale(view.scale * (e.deltaY < 0 ? 1.1 : 0.9));
    const k = scale / view.scale;
    setView({ scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k });
  };
  const zoomBy = (factor: number) => {
    const el = canvasRef.current;
    const cx = (el?.clientWidth ?? 300) / 2;
    const cy = (el?.clientHeight ?? 360) / 2;
    const scale = clampScale(view.scale * factor);
    const k = scale / view.scale;
    setView({ scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k });
  };

  return (
    <div className={fullscreen ? "fixed inset-0 z-[60] flex flex-col bg-card p-3 pt-safe" : ""}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold text-faint">
          Drag to pan · pinch/scroll to zoom · tap a node {saving && "· saving…"}
        </div>
        <div className="flex items-center gap-1.5">
        <button
          onClick={() => setFullscreen((f) => !f)}
          className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandblue"
        >
          {fullscreen ? "✕ Close" : "⤢ Expand"}
        </button>
        <button
          onClick={async () => {
            const r = await (
              await fetch("/api/admin/funnel", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reset: true }),
              })
            ).json();
            if (r.tree) setTree(r.tree);
          }}
          className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandred"
        >
          Reset to default
        </button>
        </div>
      </div>

      {/* Pannable + zoomable canvas */}
      <div
        ref={canvasRef}
        className={`relative ${
          fullscreen ? "min-h-0 flex-1" : "h-80"
        } touch-none select-none overflow-hidden rounded-xl border-2 border-line bg-card2`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      >
        {/* Zoom controls */}
        <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
          <button onClick={() => zoomBy(1.2)} className="h-7 w-7 rounded-lg border-2 border-line bg-card text-[14px] font-extrabold text-strong">+</button>
          <button onClick={() => zoomBy(1 / 1.2)} className="h-7 w-7 rounded-lg border-2 border-line bg-card text-[14px] font-extrabold text-strong">−</button>
          <button onClick={fit} title="Fit to screen" className="h-7 w-7 rounded-lg border-2 border-line bg-card text-[11px] font-extrabold text-brandblue">⤢</button>
        </div>
        <div
          className="absolute origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width, height }}
        >
          <svg className="absolute inset-0" width={width} height={height} style={{ pointerEvents: "none" }}>
            {nodes.map((n) =>
              n.parent ? (
                <line
                  key={`e${n.node.id}`}
                  x1={n.parent.x + NODE_W / 2}
                  y1={n.parent.y + NODE_H}
                  x2={n.x + NODE_W / 2}
                  y2={n.y}
                  stroke="var(--line, #cbd5e1)"
                  strokeWidth={2}
                />
              ) : null
            )}
          </svg>
          {nodes.map((n) => (
            <button
              key={n.node.id}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) return; // was a pan, not a tap
                setSel(n.node.id);
              }}
              className={`absolute overflow-hidden rounded-xl border-2 p-2 text-left ${
                sel === n.node.id
                  ? "border-brandblue bg-brandblue-soft"
                  : n.node.auto
                  ? "border-brandyellow bg-brandyellow-soft"
                  : "border-line bg-card"
              }`}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            >
              <div className="truncate text-[11px] font-extrabold text-strong">
                {n.node.auto ? "✨ " : ""}
                {n.node.label}
              </div>
              <div className="mt-0.5 line-clamp-1 text-[9px] font-bold text-faint">
                IF {n.node.condition}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[9px] text-soft">→ {n.node.message}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Node editor */}
      {selected && (
        <div className="mt-2 rounded-xl border-2 border-brandblue/40 bg-card p-2.5">
          <input
            value={selected.label}
            onChange={(e) => save(findAndMutate(tree, selected.id, (n) => (n.label = e.target.value)))}
            className="mb-1 w-full rounded-lg border-2 border-line bg-card2 p-1.5 text-[12px] font-extrabold text-strong focus:border-brandblue focus:outline-none"
          />
          <label className="text-[9px] font-extrabold uppercase text-faint">Condition (IF)</label>
          <textarea
            rows={2}
            value={selected.condition}
            onChange={(e) => save(findAndMutate(tree, selected.id, (n) => (n.condition = e.target.value)))}
            className="mb-1 w-full rounded-lg border-2 border-line bg-card2 p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none"
          />
          <label className="text-[9px] font-extrabold uppercase text-faint">Agent does (THEN)</label>
          <textarea
            rows={2}
            value={selected.message}
            onChange={(e) => save(findAndMutate(tree, selected.id, (n) => (n.message = e.target.value)))}
            className="mb-1.5 w-full rounded-lg border-2 border-line bg-card2 p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() =>
                save(
                  findAndMutate(tree, selected.id, (n) =>
                    n.children.push({
                      id: `n${Date.now().toString(36)}`,
                      label: "New branch",
                      condition: "If...",
                      message: "Then...",
                      children: [],
                    })
                  )
                )
              }
              className="btn btn-primary btn-sm rounded-lg px-2.5 text-[11px]"
            >
              + Branch
            </button>
            <button
              disabled={aiBusy}
              onClick={async () => {
                setAiBusy(true);
                try {
                  const r = await (
                    await fetch("/api/admin/funnel", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ node: selected }),
                    })
                  ).json();
                  const s = r.suggestion;
                  if (s) {
                    save(
                      findAndMutate(tree, selected.id, (n) => {
                        if (s.label) n.label = s.label;
                        if (s.condition) n.condition = s.condition;
                        if (s.message) n.message = s.message;
                        if (s.newBranch)
                          n.children.push({
                            id: `n${Date.now().toString(36)}`,
                            label: s.newBranch.label,
                            condition: s.newBranch.condition,
                            message: s.newBranch.message,
                            children: [],
                          });
                      })
                    );
                  }
                } finally {
                  setAiBusy(false);
                }
              }}
              className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2.5 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
            >
              {aiBusy ? "Thinking…" : "✨ AI suggest"}
            </button>
            {selected.id !== "root" && (
              <button
                onClick={() => {
                  save(removeNode(tree, selected.id));
                  setSel(null);
                }}
                className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2.5 text-[11px] font-extrabold text-brandred"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
