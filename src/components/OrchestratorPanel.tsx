"use client";

// The owner's 100% control surface over the agent pipeline (replaces the old
// funnel map + core-prompts editors). Three parts:
//   1. Global brain knobs (think iterations, wait window, language registers)
//   2. The agent cards - each pipeline agent's job, on/off, order and
//      instructions, plus custom agents and "when X -> then Y" edge rules
//   3. Live decisions - every real conversation decision, stage by stage
//      (input -> reasoning -> output), so nothing the agents do is invisible.

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "./LoadingDots";

interface Stage {
  id: string;
  label: string;
  enabled: boolean;
  order: number;
  instructions: string;
  custom?: boolean;
}
interface Rule {
  id: string;
  when: string;
  then: string;
  enabled: boolean;
}
interface Config {
  version: 1;
  thinkIterations: number;
  waitWindow: { minS: number; maxS: number };
  lowEnglish: boolean;
  streetLocal: boolean;
  stages: Stage[];
  rules: Rule[];
}
interface TraceStage {
  stage: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string | null;
}
interface Decision {
  decisionId: string;
  at?: string;
  userEmail: string | null;
  vendorName: string;
  stages: TraceStage[];
}

const STAGE_EMOJI: Record<string, string> = {
  opener: "✉️",
  reply: "💬",
  price: "🤝",
  validator: "🛡",
  strategist: "🧠",
  extract: "🔍",
  discipline: "📏",
  "reply-agent": "💬",
  "price-agent": "🤝",
  deliver: "📤",
};

export function OrchestratorPanel({ isOwner }: { isOwner: boolean }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [traceFilter, setTraceFilter] = useState("");
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const [tracesBusy, setTracesBusy] = useState(false);
  const filterTimer = useRef<ReturnType<typeof setTimeout>>();

  async function load(filter = "") {
    setTracesBusy(true);
    try {
      const q = filter ? `&vendor=${encodeURIComponent(filter)}` : "";
      const d = await (await fetch(`/api/admin/orchestrator?traces=1${q}`)).json();
      if (d.config) setCfg(d.config);
      setDecisions(Array.isArray(d.decisions) ? d.decisions : []);
    } catch {
      /* keep last snapshot */
    } finally {
      setTracesBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  function patchStage(id: string, patch: Partial<Stage>) {
    setCfg((c) =>
      c ? { ...c, stages: c.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : c
    );
  }
  function moveStage(id: string, dir: -1 | 1) {
    setCfg((c) => {
      if (!c) return c;
      const sorted = [...c.stages].sort((a, b) => a.order - b.order);
      const i = sorted.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return c;
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      return { ...c, stages: sorted.map((s, k) => ({ ...s, order: k + 1 })) };
    });
  }
  function patchRule(id: string, patch: Partial<Rule>) {
    setCfg((c) =>
      c ? { ...c, rules: c.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : c
    );
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/admin/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      const d = await res.json();
      if (res.ok) {
        if (d.config) setCfg(d.config);
        setSaveMsg("Saved - applies to the next conversation instantly. ✓");
      } else {
        setSaveMsg(d.error ?? "Could not save.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      const d = await (
        await fetch("/api/admin/orchestrator", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        })
      ).json();
      if (d.config) setCfg(d.config);
      setSaveMsg("Restored the built-in pipeline defaults. ✓");
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <section className="surface rounded-blob p-4">
        <LoadingDots label="Loading the agent pipeline" />
      </section>
    );
  }

  const sortedStages = [...cfg.stages].sort((a, b) => a.order - b.order);

  return (
    <>
      {/* 1. Global brain knobs */}
      <section className="surface rounded-blob p-4">
        <div className="mb-1 text-[15px] font-extrabold text-strong">
          🤖 Agent pipeline - full control
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-faint">
          Every reply flows through the agents below, in order. Hard discipline
          (ask once, never above the quote, silence after a closed session) always
          applies underneath - these settings shape everything else.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] font-bold text-faint">
            Think iterations (min 3)
            <input
              type="number"
              min={3}
              max={6}
              value={cfg.thinkIterations}
              onChange={(e) => setCfg({ ...cfg, thinkIterations: Number(e.target.value) })}
              className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-sm font-bold text-strong"
            />
          </label>
          <label className="text-[11px] font-bold text-faint">
            Strategist hold (seconds min-max)
            <div className="mt-1 flex items-center gap-1">
              <input
                type="number"
                value={cfg.waitWindow.minS}
                onChange={(e) =>
                  setCfg({ ...cfg, waitWindow: { ...cfg.waitWindow, minS: Number(e.target.value) } })
                }
                className="w-full rounded-xl border-2 border-line bg-card p-2 text-sm font-bold text-strong"
              />
              <span className="text-faint">-</span>
              <input
                type="number"
                value={cfg.waitWindow.maxS}
                onChange={(e) =>
                  setCfg({ ...cfg, waitWindow: { ...cfg.waitWindow, maxS: Number(e.target.value) } })
                }
                className="w-full rounded-xl border-2 border-line bg-card p-2 text-sm font-bold text-strong"
              />
            </div>
          </label>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => setCfg({ ...cfg, lowEnglish: !cfg.lowEnglish })}
            className={`btn chip rounded-2xl border-2 p-2.5 text-[12px] font-extrabold ${
              cfg.lowEnglish ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
            }`}
          >
            🗣 Low English abroad {cfg.lowEnglish ? "ON" : "OFF"}
          </button>
          <button
            onClick={() => setCfg({ ...cfg, streetLocal: !cfg.streetLocal })}
            className={`btn chip rounded-2xl border-2 p-2.5 text-[12px] font-extrabold ${
              cfg.streetLocal ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
            }`}
          >
            🛵 Street local language {cfg.streetLocal ? "ON" : "OFF"}
          </button>
        </div>

        {/* 2. Agent cards */}
        <div className="mt-3 space-y-2">
          {sortedStages.map((s, i) => (
            <details key={s.id} className="rounded-2xl bg-card2 p-3">
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <span className="text-base">{STAGE_EMOJI[s.id] ?? "🧩"}</span>
                <span className={`flex-1 text-[13px] font-extrabold ${s.enabled ? "text-strong" : "text-faint line-through"}`}>
                  {i + 1}. {s.label}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                    s.enabled ? "bg-savings-soft text-savings" : "bg-card text-faint"
                  }`}
                >
                  {s.enabled ? "ON" : "OFF"}
                </span>
              </summary>
              <div className="mt-2">
                <textarea
                  value={s.instructions}
                  onChange={(e) => patchStage(s.id, { instructions: e.target.value })}
                  rows={3}
                  disabled={!isOwner}
                  className="w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none disabled:opacity-60"
                  placeholder="This agent's instructions..."
                />
                {isOwner && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => patchStage(s.id, { enabled: !s.enabled })}
                      className="btn btn-ghost btn-sm rounded-xl px-2.5 py-1 text-[11px] font-extrabold"
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => moveStage(s.id, -1)}
                      className="btn btn-ghost btn-sm rounded-xl px-2.5 py-1 text-[11px] font-extrabold"
                    >
                      ↑ Earlier
                    </button>
                    <button
                      onClick={() => moveStage(s.id, 1)}
                      className="btn btn-ghost btn-sm rounded-xl px-2.5 py-1 text-[11px] font-extrabold"
                    >
                      ↓ Later
                    </button>
                    {s.custom && (
                      <button
                        onClick={() =>
                          setCfg({ ...cfg, stages: cfg.stages.filter((x) => x.id !== s.id) })
                        }
                        className="btn btn-ghost btn-sm rounded-xl px-2.5 py-1 text-[11px] font-extrabold text-brandred"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
        {isOwner && (
          <button
            onClick={() =>
              setCfg({
                ...cfg,
                stages: [
                  ...cfg.stages,
                  {
                    id: `custom-${Date.now().toString(36)}`,
                    label: "New custom agent",
                    enabled: true,
                    order: cfg.stages.length + 1,
                    instructions: "",
                    custom: true,
                  },
                ],
              })
            }
            className="btn btn-ghost mt-2 w-full rounded-2xl py-2 text-[12px] font-extrabold"
          >
            + Add a custom agent (its instructions join every draft)
          </button>
        )}

        {/* Edge rules */}
        <div className="mt-3">
          <div className="text-[12px] font-extrabold text-strong">⚡ Edge rules (when X -&gt; then Y)</div>
          <div className="mt-1.5 space-y-1.5">
            {cfg.rules.map((r) => (
              <div key={r.id} className="rounded-xl bg-card2 p-2">
                <div className="flex items-start gap-1.5">
                  <button
                    onClick={() => patchRule(r.id, { enabled: !r.enabled })}
                    disabled={!isOwner}
                    className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                      r.enabled ? "bg-savings-soft text-savings" : "bg-card text-faint"
                    }`}
                  >
                    {r.enabled ? "ON" : "OFF"}
                  </button>
                  <div className="flex-1 space-y-1">
                    <input
                      value={r.when}
                      disabled={!isOwner}
                      onChange={(e) => patchRule(r.id, { when: e.target.value })}
                      placeholder="When... (e.g. the shop offers a bigger bike)"
                      className="w-full rounded-lg border border-line bg-card p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none disabled:opacity-60"
                    />
                    <input
                      value={r.then}
                      disabled={!isOwner}
                      onChange={(e) => patchRule(r.id, { then: e.target.value })}
                      placeholder="Then... (e.g. restate our exact model and ask its price once)"
                      className="w-full rounded-lg border border-line bg-card p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none disabled:opacity-60"
                    />
                  </div>
                  {isOwner && (
                    <button
                      onClick={() => setCfg({ ...cfg, rules: cfg.rules.filter((x) => x.id !== r.id) })}
                      className="btn shrink-0 p-1 text-[12px] font-extrabold text-brandred"
                      aria-label="Delete rule"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {isOwner && (
            <button
              onClick={() =>
                setCfg({
                  ...cfg,
                  rules: [
                    ...cfg.rules,
                    { id: `rule-${Date.now().toString(36)}`, when: "", then: "", enabled: true },
                  ],
                })
              }
              className="btn btn-ghost mt-1.5 w-full rounded-2xl py-2 text-[12px] font-extrabold"
            >
              + Add an edge rule
            </button>
          )}
        </div>

        {isOwner && (
          <div className="mt-3 flex gap-2">
            <button
              onClick={save}
              disabled={busy}
              className="btn btn-primary flex-1 rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
            >
              {busy ? <LoadingDots light /> : "Save pipeline"}
            </button>
            <button
              onClick={reset}
              disabled={busy}
              className="btn btn-ghost rounded-2xl px-3 py-2.5 text-[12px] font-extrabold disabled:opacity-60"
            >
              Reset defaults
            </button>
          </div>
        )}
        {saveMsg && <p className="mt-2 text-[12px] font-bold text-savings">{saveMsg}</p>}
        {!isOwner && (
          <p className="mt-2 text-[11px] text-faint">
            Viewing as admin - only the owner can change the pipeline.
          </p>
        )}
      </section>

      {/* 3. Live decisions - full visibility */}
      <section className="surface rounded-blob p-4">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[15px] font-extrabold text-strong">🔍 Live decisions</div>
          <button
            onClick={() => load(traceFilter)}
            disabled={tracesBusy}
            className="btn btn-ghost btn-sm rounded-xl px-2.5 py-1 text-[11px] font-extrabold disabled:opacity-60"
          >
            {tracesBusy ? <LoadingDots /> : "Refresh"}
          </button>
        </div>
        <p className="mb-2 text-[11px] text-faint">
          Every real conversation decision, stage by stage: what each agent read,
          what it thought, and what it produced. Nothing the agents do is hidden.
        </p>
        <input
          value={traceFilter}
          onChange={(e) => {
            const v = e.target.value;
            setTraceFilter(v);
            clearTimeout(filterTimer.current);
            filterTimer.current = setTimeout(() => load(v), 400);
          }}
          placeholder="Filter by shop name..."
          className="mb-2 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
        />
        {decisions.length === 0 ? (
          <p className="rounded-xl bg-card2 p-3 text-center text-[11px] text-faint">
            No decisions yet - traces appear here the moment a shop replies to any
            user. (Run supabase/schema.sql once so the agent_traces table exists.)
          </p>
        ) : (
          <div className="max-h-[28rem] space-y-1.5 overflow-y-auto">
            {decisions.map((d) => (
              <div key={d.decisionId} className="rounded-xl bg-card2 p-2">
                <button
                  onClick={() =>
                    setOpenDecision(openDecision === d.decisionId ? null : d.decisionId)
                  }
                  className="btn flex w-full items-center gap-2 text-left"
                >
                  <span className="flex-1 truncate text-[12px] font-extrabold text-strong">
                    {d.vendorName}
                  </span>
                  <span className="truncate text-[10px] text-faint">{d.userEmail ?? ""}</span>
                  <span className="shrink-0 text-[10px] font-bold text-faint">
                    {d.at ? new Date(d.at).toLocaleTimeString() : ""}{" "}
                    {openDecision === d.decisionId ? "▴" : "▾"}
                  </span>
                </button>
                {openDecision === d.decisionId && (
                  <div className="mt-1.5 space-y-1.5">
                    {d.stages.map((s, i) => (
                      <div key={i} className="rounded-lg bg-card p-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-extrabold text-strong">
                          {STAGE_EMOJI[s.stage] ?? "🧩"} {s.stage}
                          {s.verdict && (
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[8px] font-extrabold ${
                                s.verdict === "veto"
                                  ? "bg-brandred-soft text-brandred"
                                  : s.verdict === "revised"
                                  ? "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
                                  : "bg-savings-soft text-savings"
                              }`}
                            >
                              {s.verdict}
                            </span>
                          )}
                        </div>
                        {s.input && (
                          <p className="mt-1 whitespace-pre-wrap break-words text-[10px] text-faint">
                            <span className="font-extrabold">in:</span> {s.input.slice(0, 400)}
                          </p>
                        )}
                        {s.reasoning && (
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-[10px] text-soft">
                            <span className="font-extrabold">thought:</span> {s.reasoning.slice(0, 400)}
                          </p>
                        )}
                        {s.output && (
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-[10px] font-bold text-strong">
                            <span className="font-extrabold">out:</span> {s.output.slice(0, 400)}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
