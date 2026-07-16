"use client";

import { useEffect, useMemo, useState } from "react";
import type { EdgeSpec, GraphSpec, NodeSpec } from "@/lib/graph/types";
import { defaultGraphSpec } from "@/lib/graph/default-graph";
import { CONDITION_VOCABULARY } from "@/lib/graph/conditions";
import { GraphCanvas } from "./GraphCanvas";
import { GraphList } from "./GraphList";
import { FlowPanel } from "./FlowPanel";
import { BackendPanel } from "./BackendPanel";
import { PlaygroundPanel } from "./PlaygroundPanel";
import { NodeSheet } from "./NodeSheet";
import { EdgeSheet } from "./EdgeSheet";
import { SimulatorPanel } from "./SimulatorPanel";
import { LiveDrillPanel } from "./LiveDrillPanel";
import { ReplayPanel } from "./ReplayPanel";
import { MediaStudio } from "./MediaStudio";
import { ScoresPanel } from "./ScoresPanel";
import { LoadingDots } from "../LoadingDots";

type Tab = "flow" | "playground" | "graph" | "simulator" | "drill" | "replay" | "media" | "scores" | "backend";
type Vocab = Parameters<typeof EdgeSheet>[0]["vocabulary"];

// The Pipeline Studio - the owner's 100%-visibility, 100%-editable control
// centre for the digraph negotiation engine. Replaces the old OrchestratorPanel.
export function PipelineStudio({ isOwner }: { isOwner: boolean }) {
  const [tab, setTab] = useState<Tab>("flow");
  // Render the DEFAULT graph instantly (no round-trip) so the Agents tab is
  // interactive at once; hydrate with the owner's saved spec when it lands.
  const [spec, setSpec] = useState<GraphSpec>(() => defaultGraphSpec());
  const [vocab, setVocab] = useState<Vocab>(() => CONDITION_VOCABULARY as unknown as Vocab);
  const [vertical, setVertical] = useState(true);
  // On phones the readable LIST view is the default; the SVG canvas is opt-in.
  const [view, setView] = useState<"list" | "graph">("list");
  const [editNode, setEditNode] = useState<NodeSpec | null>(null);
  const [editEdge, setEditEdge] = useState<EdgeSpec | null>(null);
  const [replayPath, setReplayPath] = useState<string[] | undefined>();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Vertical flow on narrow screens (portrait phones), horizontal on desktop.
    setVertical(typeof window !== "undefined" ? window.innerWidth < 700 : true);
    fetch("/api/admin/graph")
      .then((r) => r.json())
      .then((d) => {
        if (d.spec) setSpec(d.spec);
        if (d.vocabulary) setVocab(d.vocabulary);
      })
      .catch(() => setMsg("Could not load the graph."));
  }, []);

  async function save(next: GraphSpec) {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: next }),
      });
      const d = await res.json();
      if (d.ok && d.spec) {
        setSpec(d.spec);
        setDirty(false);
        setMsg("Saved - live for every conversation.");
      } else {
        setMsg((d.problems?.join("; ") || d.error) ?? "Save failed.");
      }
    } catch {
      setMsg("Save failed - check your connection.");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirm("Reset the whole graph to the default playbook? Your edits are lost.")) return;
    setSaving(true);
    const res = await fetch("/api/admin/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    const d = await res.json();
    if (d.spec) setSpec(d.spec);
    setDirty(false);
    setSaving(false);
    setMsg("Reset to defaults.");
  }

  function patchNode(n: NodeSpec) {
    if (!spec) return;
    setSpec({ ...spec, nodes: spec.nodes.map((x) => (x.id === n.id ? n : x)) });
    setDirty(true);
    setEditNode(null);
  }
  function deleteNode(id: string) {
    if (!spec) return;
    setSpec({
      ...spec,
      nodes: spec.nodes.filter((x) => x.id !== id),
      edges: spec.edges.filter((e) => e.from !== id && e.to !== id),
    });
    setDirty(true);
    setEditNode(null);
  }
  function patchEdge(e: EdgeSpec) {
    if (!spec) return;
    const exists = spec.edges.some((x) => x.id === e.id);
    setSpec({
      ...spec,
      edges: exists ? spec.edges.map((x) => (x.id === e.id ? e : x)) : [...spec.edges, e],
    });
    setDirty(true);
    setEditEdge(null);
  }
  function deleteEdge(id: string) {
    if (!spec) return;
    setSpec({ ...spec, edges: spec.edges.filter((x) => x.id !== id) });
    setDirty(true);
    setEditEdge(null);
  }
  function addCustomNode() {
    if (!spec) return;
    const id = `custom-${Math.random().toString(36).slice(2, 7)}`;
    const node: NodeSpec = {
      id,
      kind: "custom-llm",
      label: "Custom agent",
      emoji: "✨",
      enabled: true,
      instructions: "",
      custom: true,
      promptTemplate:
        "The shop said: {shopMessage}\nConversation: {history}\nWrite the traveller's next reply.",
      maxRunsPerThread: 2,
    };
    setSpec({ ...spec, nodes: [...spec.nodes, node] });
    setDirty(true);
    setEditNode(node);
  }
  function addEdge() {
    if (!spec) return;
    const id = `edge-${Math.random().toString(36).slice(2, 7)}`;
    const edge: EdgeSpec = {
      id,
      from: "director",
      to: spec.nodes.find((n) => n.kind === "close")?.id ?? spec.nodes[0].id,
      priority: 100,
      when: { kind: "always" },
      enabled: true,
      label: "new edge",
    };
    setEditEdge(edge);
  }

  const runCounts = useMemo(() => {
    if (!replayPath) return undefined;
    const c: Record<string, number> = {};
    for (const id of replayPath) c[id] = (c[id] ?? 0) + 1;
    return c;
  }, [replayPath]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "flow", label: "📖 Flow" },
    { id: "playground", label: "🎭 Playground" },
    { id: "graph", label: "🕸️ Pipeline" },
    { id: "simulator", label: "🧪 Simulator" },
    { id: "drill", label: "📞 Live Drill" },
    { id: "replay", label: "🎬 Replay" },
    { id: "media", label: "🖼️ Media Lab" },
    { id: "scores", label: "🏅 Scores" },
    { id: "backend", label: "🔧 Backend" },
  ];

  return (
    <div className="surface rounded-blob p-3 sm:p-4">
      <div className="mb-3">
        <h3 className="text-base font-extrabold text-strong">🧠 Pipeline Studio</h3>
        <p className="text-[12px] text-soft">
          The exact directed graph your agents follow in every WhatsApp chat -
          fully editable, testable and replayable. What you see here is what
          actually runs.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`btn btn-sm rounded-full px-3 py-1.5 text-[12px] font-bold ${
              tab === t.id ? "bg-brandblue text-white" : "border border-line text-soft"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-3 rounded-xl bg-brandblue-soft p-2 text-[12px] font-bold text-brandblue">
          {msg}
        </div>
      )}

      {tab === "graph" && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* List is the readable phone default; Graph is the SVG canvas. */}
            <div className="flex rounded-lg border border-line p-0.5">
              {(["list", "graph"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`btn btn-sm rounded-md px-2.5 py-1 text-[12px] font-bold ${
                    view === v ? "bg-brandblue text-white" : "text-soft"
                  }`}
                >
                  {v === "list" ? "☰ List" : "🕸 Graph"}
                </button>
              ))}
            </div>
            <button onClick={addCustomNode} className="btn btn-sm rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-brandblue">
              + Custom node
            </button>
            <button onClick={addEdge} className="btn btn-sm rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-brandblue">
              + Edge
            </button>
            {view === "graph" && (
              <button
                onClick={() => setVertical((v) => !v)}
                className="btn btn-sm rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-soft"
              >
                {vertical ? "↔ Horizontal" : "↕ Vertical"}
              </button>
            )}
            {replayPath && (
              <button
                onClick={() => setReplayPath(undefined)}
                className="btn btn-sm rounded-lg border border-line px-2.5 py-1 text-[12px] font-bold text-soft"
              >
                Clear replay overlay
              </button>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => save(spec)}
                disabled={saving || !dirty}
                className="btn btn-primary rounded-lg px-3 py-1.5 text-[12px] disabled:opacity-40"
              >
                {saving ? "Saving..." : dirty ? "Save changes" : "Saved"}
              </button>
              <button onClick={reset} className="btn btn-sm rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-bold text-brandred">
                Reset
              </button>
            </div>
          </div>

          {view === "list" ? (
            <GraphList
              spec={spec}
              runCounts={runCounts}
              onNode={(n) => setEditNode(n)}
              onEdge={(e) => setEditEdge(e)}
            />
          ) : (
            <GraphCanvas
              spec={spec}
              vertical={vertical}
              runCounts={runCounts}
              path={replayPath}
              selectedNode={editNode?.id}
              onNode={(n) => setEditNode(n)}
              onEdge={(e) => setEditEdge(e)}
            />
          )}

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Knob label="Max bargain rounds / shop" value={spec.settings.maxRoundsPerShop} min={1} max={6}
              onChange={(v) => { setSpec({ ...spec, settings: { ...spec.settings, maxRoundsPerShop: v } }); setDirty(true); }} />
            <Knob label="Strategic wait cap (min)" value={spec.settings.strategicWaitMaxMin} min={1} max={240}
              onChange={(v) => { setSpec({ ...spec, settings: { ...spec.settings, strategicWaitMaxMin: v } }); setDirty(true); }} />
            <Knob label="Judge sample rate (%)" value={Math.round(spec.settings.judgeSampleRate * 100)} min={0} max={100}
              onChange={(v) => { setSpec({ ...spec, settings: { ...spec.settings, judgeSampleRate: v / 100 } }); setDirty(true); }} />
          </div>
          <label className="mt-2 flex items-center gap-2 rounded-xl bg-card2 p-2.5 text-[12px] font-bold text-soft">
            <input
              type="checkbox"
              checked={spec.settings.emojiTone}
              onChange={(e) => { setSpec({ ...spec, settings: { ...spec.settings, emojiTone: e.target.checked } }); setDirty(true); }}
              className="h-5 w-5 accent-[var(--blue)]"
            />
            Require exactly one warm emoji in every outbound message
          </label>
        </div>
      )}

      {tab === "simulator" && <SimulatorPanel />}
      {tab === "drill" && <LiveDrillPanel />}
      {tab === "replay" && (
        <ReplayPanel
          onPreviewPath={(path) => {
            setReplayPath(path);
            setTab("graph");
          }}
          spec={spec}
        />
      )}
      {tab === "media" && <MediaStudio />}
      {tab === "scores" && <ScoresPanel />}
      {tab === "flow" && (
        <FlowPanel
          spec={spec}
          onNode={(n) => setEditNode(n)}
          onEdge={(e) => setEditEdge(e)}
        />
      )}
      {tab === "playground" && <PlaygroundPanel />}
      {tab === "backend" && <BackendPanel />}

      {editNode && (
        <NodeSheet
          node={editNode}
          onSave={patchNode}
          onDelete={editNode.custom ? deleteNode : undefined}
          onClose={() => setEditNode(null)}
        />
      )}
      {editEdge && (
        <EdgeSheet
          edge={editEdge}
          nodes={spec.nodes}
          vocabulary={vocab}
          onSave={patchEdge}
          onDelete={deleteEdge}
          onClose={() => setEditEdge(null)}
        />
      )}
    </div>
  );
}

function Knob({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="rounded-xl bg-card2 p-2.5 text-[11px] font-bold text-soft">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
        className="mt-1 w-full rounded-lg border-2 border-line bg-card p-1.5 text-[14px] text-strong"
      />
    </label>
  );
}
