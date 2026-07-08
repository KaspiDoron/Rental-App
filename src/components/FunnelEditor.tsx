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
  const [pan, setPan] = useState({ x: 10, y: 0 });
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    fetch("/api/admin/funnel")
      .then((r) => r.json())
      .then((d) => d.tree && setTree(d.tree))
      .catch(() => {});
  }, []);

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

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onUp = () => (drag.current = null);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-bold text-faint">
          Drag the map to pan · tap a node to edit {saving && "· saving…"}
        </div>
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

      {/* Pannable canvas */}
      <div
        className="relative h-72 touch-none overflow-hidden rounded-xl border-2 border-line bg-card2"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        <div
          className="absolute"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, width, height }}
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
