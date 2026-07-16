"use client";

import { useEffect, useRef, useState } from "react";
import { PlaceAutocomplete } from "../PlaceAutocomplete";
import { LoadingDots } from "../LoadingDots";
import { CoachBox } from "./CoachBox";

// The interactive Playground: YOU are the rental shop (or an AI persona is),
// chatting against the REAL negotiation engine turn by turn - same graph, same
// prompts, zero WhatsApp traffic. Every agent reply carries the Director's
// full decision ladder so "why did it do that?" is one tap away.

interface LadderRung {
  edgeId: string;
  label: string;
  toNodeId: string;
  toKind: string;
  emoji?: string;
  legal: boolean;
  chosen: boolean;
  why: string;
}

interface TurnState {
  pricePerDay?: number;
  currency?: string;
  depositType?: string;
  depositAmount?: number;
  fulfillment?: string | null;
  rounds: number;
  firmCount: number;
  dealComplete: boolean;
  lastTarget?: number;
  lastLeverage?: string;
  mileageKm?: number;
  conditionNotes?: string;
  toneDegraded?: boolean;
  nodeRuns?: Record<string, number>;
  phase?: string;
  waitingUntil?: string | null;
}

interface TurnStage {
  stage: string;
  nodeId?: string;
  edgeId?: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string;
  ms?: number;
}

interface ChatEntry {
  role: "shop" | "agent";
  text: string;
  voice?: boolean;
  imageKind?: string;
  aiGenerated?: boolean;
  action?: string;
  ladder?: LadderRung[];
  state?: TurnState;
  stages?: TurnStage[];
  path?: string[];
}

const QUICK_SHOP_LINES = [
  "Yes have, 250 per day",
  "Okay for you 200 per day",
  "Cannot lower, last price",
  "Deposit passport only",
  "Okay 3000 cash deposit is fine",
  "We deliver to your hotel free",
  "You come pick up at shop",
  "What day you want start?",
];

const DEFAULT_PERSONA =
  "You are a rental shop owner in Chiang Mai. Slightly broken English, friendly, " +
  "starts at 250 baht/day for a 125cc, real bottom is 160. Prefers passport deposit " +
  "but accepts 3000 cash if pushed. Only shop pickup.";

interface SuggestedScenario {
  id: string;
  label: string;
  region: string;
  rfq: { vehicleClass?: string; engineSizeCc?: number; durationDays?: number };
  rivalPricePerDay?: number;
  persona: string;
  opening: string;
  fromAi: boolean;
}

export function PlaygroundPanel() {
  const [mode, setMode] = useState<"me" | "ai">("me");
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [region, setRegion] = useState("Chiang Mai, Thailand");
  const [cc, setCc] = useState(125);
  const [vehicle, setVehicle] = useState<"scooter" | "motorbike">("motorbike");
  const [days, setDays] = useState(3);
  const [rival, setRival] = useState<string>("");
  const [voice, setVoice] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [whyOpen, setWhyOpen] = useState<number | null>(null);
  const [debugOpen, setDebugOpen] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState(true);
  const carried = useRef<unknown>(null);
  const historyLines = useRef<string[] | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement>(null);
  // AI-suggested test scenarios: each tested one is replaced by a fresh one.
  const [suggestions, setSuggestions] = useState<SuggestedScenario[]>([]);
  const testedLabels = useRef<string[]>([]);

  async function fetchSuggestion(extraExclude: string[] = []) {
    try {
      const res = await fetch("/api/admin/graph/scenario-gen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exclude: [...testedLabels.current, ...extraExclude] }),
      });
      const d = await res.json();
      if (d.scenario) setSuggestions((old) => [...old.filter((s) => s.id !== d.scenario.id), d.scenario].slice(-2));
    } catch {
      /* suggestions are an enhancement */
    }
  }

  useEffect(() => {
    // Two live suggestions at a time.
    fetchSuggestion().then(() => fetchSuggestion());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendTurn(args: {
    shopSays?: string;
    imageKind?: "vehicle" | "price_sheet";
    aiShop?: boolean;
    setup?: { region: string; vehicle: string; cc: number; days: number; rival?: number; persona: string };
  }) {
    setBusy(true);
    setErr(null);
    setSetupOpen(false);
    const s = args.setup;
    try {
      const res = await fetch("/api/admin/graph/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "playground",
          shopSays: args.shopSays,
          voice: voice && !args.imageKind,
          imageKind: args.imageKind,
          aiShop: args.aiShop,
          persona: args.aiShop ? s?.persona ?? persona : undefined,
          region: s?.region ?? region,
          rivalPricePerDay: (s ? s.rival : Number(rival) > 0 ? Number(rival) : undefined) || undefined,
          rfq: {
            vehicleClass: s?.vehicle ?? vehicle,
            engineSizeCc: s?.cc ?? cc,
            durationDays: s?.days ?? days,
          },
          carried: carried.current,
          historyLines: historyLines.current,
        }),
      });
      const d = await res.json();
      if (!d.playground) {
        setErr(d.error ?? "The engine did not answer - try again.");
        return;
      }
      const p = d.playground;
      carried.current = p.carried;
      historyLines.current = p.historyLines;
      setLog((old) => [
        ...old,
        {
          role: "shop",
          text: p.shopSays || "(photo)",
          voice: voice && !args.imageKind,
          imageKind: args.imageKind,
          aiGenerated: p.aiGenerated,
        },
        {
          role: "agent",
          text: p.turn.ourReply ?? "",
          action: p.turn.action,
          ladder: p.turn.ladder,
          state: p.turn.state,
          stages: p.turn.stages,
          path: p.turn.path,
        },
      ]);
      setText("");
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 60);
    } catch {
      setErr("Request failed - check your connection.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    carried.current = null;
    historyLines.current = undefined;
    setLog([]);
    setErr(null);
    setWhyOpen(null);
    setSetupOpen(true);
  }

  // Start a suggested scenario: load its setup, let the AI persona take over,
  // play the shop's opening line immediately - and replace the used suggestion
  // with a freshly generated one.
  function playScenario(s: SuggestedScenario) {
    carried.current = null;
    historyLines.current = undefined;
    setLog([]);
    setErr(null);
    setWhyOpen(null);
    setMode("ai");
    setRegion(s.region);
    setVehicle(s.rfq.vehicleClass === "motorbike" ? "motorbike" : "scooter");
    setCc(s.rfq.engineSizeCc ?? 125);
    setDays(s.rfq.durationDays ?? 3);
    setRival(s.rivalPricePerDay ? String(s.rivalPricePerDay) : "");
    setPersona(s.persona);
    testedLabels.current = [...testedLabels.current, s.label].slice(-24);
    setSuggestions((old) => old.filter((x) => x.id !== s.id));
    fetchSuggestion(suggestions.map((x) => x.label));
    sendTurn({
      shopSays: s.opening,
      setup: {
        region: s.region,
        vehicle: s.rfq.vehicleClass === "motorbike" ? "motorbike" : "scooter",
        cc: s.rfq.engineSizeCc ?? 125,
        days: s.rfq.durationDays ?? 3,
        rival: s.rivalPricePerDay,
        persona: s.persona,
      },
    });
  }

  // A readable transcript of the current run - what the Coach scores.
  function transcript(): string {
    return log
      .map((e) =>
        e.role === "shop"
          ? `Shop: ${e.text}`
          : `Agent [${e.action}]: ${e.text || "(silent)"}`
      )
      .join("\n")
      .slice(0, 3500);
  }

  return (
    <div className="space-y-3">
      {/* AI-suggested scenarios - each tested one is replaced by a fresh one */}
      {suggestions.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-extrabold text-strong">
            🎲 Suggested test scenarios (AI-generated - tap to play)
          </div>
          <div className="space-y-1.5">
            {suggestions.map((s) => (
              <button
                key={s.id}
                onClick={() => playScenario(s)}
                disabled={busy}
                className="btn w-full rounded-2xl border border-line bg-card p-2.5 text-left hover:border-brandblue disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5 text-[12px] font-extrabold text-strong">
                  {s.label}
                  <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-[9px] font-bold text-brandblue">
                    {s.fromAi ? "AI" : "pool"}
                  </span>
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-faint">
                  {s.region} · {s.rfq.engineSizeCc}cc {s.rfq.vehicleClass} · {s.rfq.durationDays} days
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-soft">{s.persona.slice(0, 120)}...</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode("me")}
          className={`btn btn-sm flex-1 rounded-xl border-2 py-2 text-[12px] font-bold ${
            mode === "me" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
          }`}
        >
          🧑 I am the shop
        </button>
        <button
          onClick={() => setMode("ai")}
          className={`btn btn-sm flex-1 rounded-xl border-2 py-2 text-[12px] font-bold ${
            mode === "ai" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
          }`}
        >
          🤖 AI plays the shop
        </button>
      </div>

      {/* Setup (collapses once the chat starts) */}
      <div className="rounded-2xl border border-line bg-card">
        <button
          onClick={() => setSetupOpen((v) => !v)}
          className="btn flex w-full items-center justify-between p-2.5 text-left text-[12px] font-extrabold text-strong"
        >
          ⚙️ Scenario: {cc}cc {vehicle}, {days} day{days > 1 ? "s" : ""}
          {Number(rival) > 0 ? ` · rival ${rival}/day` : ""}
          <span className="text-faint">{setupOpen ? "▲" : "▼"}</span>
        </button>
        {setupOpen && (
          <div className="border-t border-line p-2.5">
            <PlaceAutocomplete label="Shop region" value={region} onText={setRegion} minChars={2} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {([
                ["scooter", 110],
                ["motorbike", 125],
                ["scooter", 155],
              ] as const).map(([v, c]) => (
                <button
                  key={`${v}${c}`}
                  onClick={() => {
                    setVehicle(v);
                    setCc(c);
                  }}
                  className={`btn btn-sm rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                    vehicle === v && cc === c ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
                  }`}
                >
                  {c}cc {v}
                </button>
              ))}
              {[1, 3, 7].map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`btn btn-sm rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                    days === d ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
                  }`}
                >
                  {d} day{d > 1 ? "s" : ""}
                </button>
              ))}
            </div>
            <label className="mt-2 block text-[11px] font-bold text-soft">
              Rival offer in this session (cross-shop leverage, optional)
              <input
                value={rival}
                onChange={(e) => setRival(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                placeholder="e.g. 200"
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[16px] text-strong"
              />
            </label>
            {mode === "ai" && (
              <label className="mt-2 block text-[11px] font-bold text-soft">
                Shop persona (the AI shop follows this)
                <textarea
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
                />
              </label>
            )}
          </div>
        )}
      </div>

      {/* Chat */}
      <div className="rounded-2xl border border-line bg-card2 p-2.5">
        {log.length === 0 && (
          <p className="py-4 text-center text-[12px] text-faint">
            {mode === "me"
              ? "Type the shop's first reply below (or tap a quick line) - your agent answers with the REAL engine."
              : "Tap \"Shop replies\" and the AI persona sends the shop's next message - your agent answers for real."}
          </p>
        )}
        <div className="space-y-2">
          {log.map((e, i) =>
            e.role === "shop" ? (
              <div key={i} className="mr-auto max-w-[88%] rounded-xl bg-card px-2.5 py-1.5 text-[13px] text-strong">
                <span className="mb-0.5 block text-[9px] font-extrabold uppercase opacity-60">
                  🏪 Shop{e.aiGenerated ? " (AI)" : ""}
                  {e.voice ? " · voice note" : ""}
                  {e.imageKind ? ` · ${e.imageKind === "vehicle" ? "vehicle photo" : "price-sheet photo"}` : ""}
                </span>
                {e.text}
              </div>
            ) : (
              <div key={i} className="ml-auto max-w-[88%]">
                {e.text ? (
                  <div className="rounded-xl bg-brandblue px-2.5 py-1.5 text-[13px] text-white">
                    <span className="mb-0.5 block text-[9px] font-extrabold uppercase opacity-70">
                      🤖 Your agent · {e.action}
                    </span>
                    {e.text}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-line px-2.5 py-1.5 text-[12px] italic text-faint">
                    (deliberately silent - {e.action})
                  </div>
                )}
                {e.state && (
                  <div className="mt-1 flex flex-wrap justify-end gap-1 text-[9px] font-bold">
                    {e.state.pricePerDay ? (
                      <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                        💰 {e.state.pricePerDay} {e.state.currency}/day
                      </span>
                    ) : null}
                    {e.state.depositType || e.state.depositAmount ? (
                      <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                        🔒 {e.state.depositType === "passport" ? "passport" : ""}
                        {e.state.depositAmount ? ` ${e.state.depositAmount} cash` : ""}
                      </span>
                    ) : null}
                    {e.state.fulfillment ? (
                      <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                        {e.state.fulfillment === "delivery" ? "🛵 delivery" : e.state.fulfillment === "pickup" ? "🚗 pickup" : "🏪 on shop"}
                      </span>
                    ) : null}
                    {e.state.firmCount > 0 && (
                      <span className="rounded-full bg-card px-1.5 py-0.5 text-faint">firm ×{e.state.firmCount}</span>
                    )}
                    {e.state.dealComplete && (
                      <span className="rounded-full bg-savings-soft px-1.5 py-0.5 text-savings">✅ deal complete</span>
                    )}
                  </div>
                )}
                {(e.ladder?.length || e.stages?.length) && (
                  <div className="mt-1 flex justify-end gap-1.5">
                    {e.stages && e.stages.length > 0 && (
                      <button
                        onClick={() => setDebugOpen(debugOpen === i ? null : i)}
                        className="btn btn-sm rounded-full border border-line px-2 py-0.5 text-[10px] font-bold text-soft"
                      >
                        {debugOpen === i ? "Hide debug" : "🔬 Debug"}
                      </button>
                    )}
                    {e.ladder && e.ladder.length > 0 && (
                      <button
                        onClick={() => setWhyOpen(whyOpen === i ? null : i)}
                        className="btn btn-sm rounded-full border border-line px-2 py-0.5 text-[10px] font-bold text-brandblue"
                      >
                        {whyOpen === i ? "Hide why" : "Why this move?"}
                      </button>
                    )}
                  </div>
                )}
                {debugOpen === i && e.stages && (
                  <div className="mt-1 rounded-xl border border-line bg-card p-2 text-left">
                    <div className="mb-1 text-[10px] font-extrabold text-strong">
                      Execution timeline - every stage, its reasoning and latency:
                    </div>
                    {/* Traversed path at a glance */}
                    {e.path && e.path.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px] font-bold text-soft">
                        {e.path.map((p, j) => (
                          <span key={j} className="flex items-center gap-1">
                            {j > 0 && <span className="text-faint">→</span>}
                            <span className="rounded-full bg-card2 px-1.5 py-0.5">{p}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="space-y-1">
                      {e.stages.map((s, j) => (
                        <div key={j} className="rounded-lg bg-card2 px-1.5 py-1 text-[10px] leading-snug">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-extrabold text-strong">{s.stage}</span>
                            <span className="flex shrink-0 items-center gap-1">
                              {s.verdict === "deterministic" && (
                                <span className="rounded-full bg-brandyellow-soft px-1.5 py-0.5 text-[9px] font-bold text-[#8a6100] dark:text-brandyellow">
                                  no-AI fallback
                                </span>
                              )}
                              {typeof s.ms === "number" && (
                                <span className="tabular-nums text-faint">{s.ms}ms</span>
                              )}
                            </span>
                          </div>
                          {s.reasoning && <div className="mt-0.5 text-soft">{s.reasoning.slice(0, 200)}</div>}
                          {s.output && (
                            <div className="mt-0.5 truncate text-faint">→ {s.output.slice(0, 140)}</div>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* Deal memory - everything the thread remembers */}
                    {e.state && (
                      <div className="mt-1.5 border-t border-line pt-1.5 text-[10px] text-soft">
                        <span className="font-extrabold text-strong">Deal memory:</span>{" "}
                        {[
                          e.state.lastTarget ? `last ask ${e.state.lastTarget}` : "",
                          e.state.lastLeverage ? `leverage: ${e.state.lastLeverage}` : "",
                          e.state.mileageKm ? `mileage ${e.state.mileageKm}km` : "",
                          e.state.conditionNotes ? `condition: ${e.state.conditionNotes}` : "",
                          e.state.toneDegraded ? "tone: annoyed" : "",
                          e.state.phase ? `phase ${e.state.phase}` : "",
                          e.state.waitingUntil ? `waiting until ${e.state.waitingUntil}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "(nothing beyond the chips above)"}
                        {e.state.nodeRuns && Object.keys(e.state.nodeRuns).length > 0 && (
                          <span className="mt-0.5 block text-faint">
                            node budgets used:{" "}
                            {Object.entries(e.state.nodeRuns)
                              .map(([k, v]) => `${k}×${v}`)
                              .join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {whyOpen === i && e.ladder && (
                  <div className="mt-1 rounded-xl border border-line bg-card p-2 text-left">
                    <div className="mb-1 text-[10px] font-extrabold text-strong">
                      The Director checked top to bottom and took the first move that fit:
                    </div>
                    {e.ladder.map((r, j) => (
                      <div
                        key={r.edgeId}
                        className={`flex items-start gap-1.5 rounded-lg px-1.5 py-1 text-[11px] ${
                          r.chosen ? "bg-savings-soft" : ""
                        }`}
                      >
                        <span className="shrink-0">{r.chosen ? "✅" : r.legal ? "🔵" : "⬜"}</span>
                        <span className="min-w-0">
                          <span className={`font-bold ${r.chosen ? "text-savings" : r.legal ? "text-strong" : "text-faint"}`}>
                            {j + 1}. {r.emoji} {r.label}
                          </span>
                          <span className={`block ${r.chosen ? "text-savings" : "text-faint"}`}>
                            {r.chosen
                              ? `picked - ${r.why}`
                              : r.legal
                              ? "was allowed too, but a higher rule matched first (or the Director preferred another)"
                              : `skipped - ${r.why}`}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
        {busy && (
          <div className="mt-2">
            <LoadingDots label={mode === "ai" ? "AI shop is typing, then your agent answers" : "Your agent is thinking"} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {err && <div className="rounded-xl bg-brandred/10 p-2 text-[12px] font-bold text-brandred">{err}</div>}

      {/* Composer */}
      {mode === "me" ? (
        <div>
          <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {QUICK_SHOP_LINES.map((q) => (
              <button
                key={q}
                onClick={() => sendTurn({ shopSays: q })}
                disabled={busy}
                className="btn btn-sm shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
              >
                {q}
              </button>
            ))}
            <button
              onClick={() => sendTurn({ imageKind: "vehicle" })}
              disabled={busy}
              className="btn btn-sm shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
            >
              📷 send vehicle photo
            </button>
            <button
              onClick={() => sendTurn({ imageKind: "price_sheet" })}
              disabled={busy}
              className="btn btn-sm shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
            >
              📷 send price sheet
            </button>
            {/* Location pins / contact cards: the EXACT synthesized text the
                production webhook feeds the engine - byte-for-byte parity. */}
            <button
              onClick={() =>
                sendTurn({
                  shopSays:
                    "(the shop shared its location: Shop location - https://maps.google.com/?q=18.7883,98.9853)",
                })
              }
              disabled={busy}
              className="btn btn-sm shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
            >
              📍 send location pin
            </button>
            <button
              onClick={() =>
                sendTurn({
                  shopSays: "(the shop shared a contact: Boss +66812345678)",
                })
              }
              disabled={busy}
              className="btn btn-sm shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
            >
              👤 send contact card
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() => setVoice((v) => !v)}
              title="Send as a voice note (transcript)"
              className={`btn btn-sm shrink-0 rounded-xl border-2 px-2 py-2.5 text-[13px] ${
                voice ? "border-brandblue bg-brandblue-soft" : "border-line"
              }`}
            >
              🎙️
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim() && !busy) sendTurn({ shopSays: text.trim() });
              }}
              placeholder={voice ? "Type what the shop SAYS in the voice note..." : "Type the shop's message..."}
              className="w-full rounded-xl border-2 border-line bg-card px-3 py-2.5 text-[16px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            <button
              onClick={() => text.trim() && sendTurn({ shopSays: text.trim() })}
              disabled={busy || !text.trim()}
              className="btn btn-primary shrink-0 rounded-xl px-3 py-2.5 text-[13px] font-bold disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => sendTurn({ aiShop: true })}
          disabled={busy}
          className="btn btn-primary w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-50"
        >
          ▶️ Shop replies (AI persona) - then my agent answers
        </button>
      )}

      {log.length > 0 && (
        <>
          <CoachBox
            title="🏅 Score this negotiation - the pipeline learns from it"
            placeholder="Your verdict on this run: what was good, what was wrong, what should the agents do differently next time?"
            context={transcript}
          />
          <button
            onClick={reset}
            className="btn btn-sm w-full rounded-xl border border-line py-2 text-[12px] font-bold text-soft"
          >
            ↺ Start a new negotiation
          </button>
        </>
      )}
    </div>
  );
}
