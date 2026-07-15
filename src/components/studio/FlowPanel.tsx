"use client";

import { useEffect, useState } from "react";
import type { EdgeSpec, GraphSpec, NodeSpec } from "@/lib/graph/types";
import { describeConditionText } from "@/lib/graph/conditions";
import { LoadingDots } from "../LoadingDots";
import { CoachBox } from "./CoachBox";

// THE answer to "who is first, what comes next": a plain-language storyline of
// a search session, the Director's REAL decision order (from the live spec, by
// priority), and a Scenario Player that replays the owner's example shop
// conversations through the actual engine turn by turn.

interface PlayedTurn {
  shopSays: string;
  voice?: boolean;
  imageKind?: string;
  action: string;
  ourReply: string | null;
  path: string[];
  state: {
    pricePerDay?: number;
    currency?: string;
    depositType?: string;
    depositAmount?: number;
    fulfillment?: string | null;
    rounds: number;
    firmCount: number;
    dealComplete: boolean;
  };
}

const STORY: { step: string; detail: string; nodeIds: string[] }[] = [
  { step: "1. You search", detail: "The Profiler turns your words into an exact request (vehicle, cc, days).", nodeIds: [] },
  { step: "2. Openers go out", detail: "Every nearby shop gets its own differently-worded first message - never the same twice.", nodeIds: [] },
  { step: "3. A shop replies", detail: "Voice notes get transcribed (heavy accents), photos get read (price boards, odometers), then the Extractor pulls price/deposit/terms and the Coherence check makes sure a media reading really fits the conversation.", nodeIds: ["transcribe", "extract", "coherence"] },
  { step: "4. The numbers", detail: "The Comparator anchors on the real local floor price and finds the cheapest rival offer in YOUR session - honest leverage.", nodeIds: ["comparator"] },
  { step: "5. The Director decides", detail: "One legal move per reply, in the priority order below. It can also deliberately WAIT - patience is leverage.", nodeIds: ["director"] },
  { step: "6. Quality gates", detail: "Style + global uniqueness (no two identical messages app-wide), local-language stickiness, safety, then human-paced anti-ban delivery.", nodeIds: ["style-validator", "localize", "safety", "deliver"] },
  { step: "7. The deal appears", detail: "Only when price + deposit + how-you-get-it are ALL known does the card show the offer with its tags. Judges score every move afterwards.", nodeIds: ["present"] },
];

export function FlowPanel({
  spec,
  onNode,
  onEdge,
}: {
  spec: GraphSpec;
  onNode: (n: NodeSpec) => void;
  onEdge: (e: EdgeSpec) => void;
}) {
  const [scripts, setScripts] = useState<{ id: string; label: string }[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [turns, setTurns] = useState<PlayedTurn[] | null>(null);
  const [playLabel, setPlayLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/graph/simulate")
      .then((r) => r.json())
      .then((d) => setScripts(d.conversations ?? []))
      .catch(() => {});
  }, []);

  const nodeById = (id: string) => spec.nodes.find((n) => n.id === id);
  const nodeName = (id: string) => nodeById(id)?.label.split(" - ")[0] ?? id;

  // The Director's REAL decision order - enabled edges by priority.
  const directorOrder = spec.edges
    .filter((e) => e.enabled && e.from === "director")
    .sort((a, b) => a.priority - b.priority);

  async function play(id: string, label: string) {
    setPlaying(id);
    setTurns(null);
    setErr(null);
    setPlayLabel(label);
    try {
      const res = await fetch("/api/admin/graph/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "conversation", scriptId: id }),
      });
      const d = await res.json();
      if (d.conversation?.turns) setTurns(d.conversation.turns);
      else setErr(d.error ?? "Playback failed.");
    } catch {
      setErr("Playback failed - check your connection.");
    } finally {
      setPlaying(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* 1. The storyline */}
      <div>
        <div className="mb-1.5 text-[12px] font-extrabold text-strong">
          📖 How every search session runs
        </div>
        <div className="space-y-1.5">
          {STORY.map((s) => (
            <div key={s.step} className="rounded-xl border border-line bg-card p-2.5">
              <div className="text-[12px] font-extrabold text-strong">{s.step}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-soft">{s.detail}</div>
              {s.nodeIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.nodeIds.map((id) => {
                    const node = nodeById(id);
                    if (!node) return null;
                    return (
                      <button
                        key={id}
                        onClick={() => onNode(node)}
                        className="btn btn-sm rounded-full border border-line px-2 py-0.5 text-[10px] font-bold text-brandblue hover:border-brandblue"
                      >
                        {node.emoji} {nodeName(id)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 2. The Director's real priority ladder */}
      <div>
        <div className="mb-1 text-[12px] font-extrabold text-strong">
          🧠 The Director&apos;s ladder (live)
        </div>
        <p className="mb-1.5 text-[11px] leading-relaxed text-soft">
          On every shop message the Director reads this list <b>top to bottom</b> and takes the{" "}
          <b>first move whose &quot;when&quot; is true</b>. That is the whole branching logic.
        </p>
        <div className="space-y-1">
          {directorOrder.map((e, i) => (
            <div key={e.id}>
              <button
                onClick={() => onEdge(e)}
                className="btn w-full rounded-xl border border-line bg-card px-2.5 py-2 text-left hover:border-brandblue"
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brandblue-soft text-[10px] font-extrabold text-brandblue">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-strong">
                    {nodeById(e.to)?.emoji} {e.label ?? e.id}
                  </span>
                  <span className="shrink-0 text-[10px] text-faint">→ {nodeName(e.to)}</span>
                </span>
                <span className="mt-0.5 block pl-7 text-[10px] leading-snug text-faint">
                  when: {describeConditionText(e.when)}
                </span>
              </button>
              {i < directorOrder.length - 1 && (
                <div className="pl-4 text-[9px] font-bold text-faint">otherwise ↓</div>
              )}
            </div>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-faint">
          Tap a rule to edit its condition or order. With an AI key the Director may also WAIT
          strategically; without one it takes the first matching rule - exactly this list. Try it
          live in the 🎭 Playground tab: you type as the shop, then tap &quot;Why this move?&quot;
          on any reply to see this ladder with the picked/skipped reasons.
        </p>
      </div>

      {/* 3. Scenario Player */}
      <div>
        <div className="mb-1.5 text-[12px] font-extrabold text-strong">
          ▶️ Play a full negotiation (the real engine, no WhatsApp)
        </div>
        <div className="flex flex-wrap gap-1.5">
          {scripts.map((s) => (
            <button
              key={s.id}
              onClick={() => play(s.id, s.label)}
              disabled={playing !== null}
              className="btn btn-sm rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue disabled:opacity-50"
            >
              {playing === s.id ? "Playing..." : s.label}
            </button>
          ))}
        </div>
        {playing && <div className="mt-2"><LoadingDots label="Negotiating with the scripted shop" /></div>}
        {err && <div className="mt-2 rounded-xl bg-brandred/10 p-2 text-[12px] font-bold text-brandred">{err}</div>}

        {turns && (
          <div className="mt-2 space-y-2">
            <div className="text-[11px] font-bold text-faint">{playLabel}</div>
            {turns.map((t, i) => (
              <div key={i} className="rounded-2xl border border-line bg-card p-2.5">
                <div className="mr-auto max-w-[90%] rounded-xl bg-card2 px-2.5 py-1.5 text-[12px] text-strong">
                  <span className="mb-0.5 block text-[9px] font-extrabold uppercase opacity-60">
                    🏪 Shop {t.voice ? "(voice note)" : t.imageKind ? `(${t.imageKind} photo)` : ""}
                  </span>
                  {t.shopSays || "(photo only)"}
                </div>
                <div className="my-1.5 flex flex-wrap items-center gap-1 text-[10px] text-faint">
                  <span className="font-bold">path:</span>
                  {t.path.map((p, j) => (
                    <span key={j} className="rounded bg-card2 px-1.5 py-0.5">{nodeName(p)}</span>
                  ))}
                </div>
                {t.ourReply ? (
                  <div className="ml-auto max-w-[90%] rounded-xl bg-brandblue px-2.5 py-1.5 text-[12px] text-white">
                    <span className="mb-0.5 block text-[9px] font-extrabold uppercase opacity-70">
                      🤖 Your agent ({t.action})
                    </span>
                    {t.ourReply}
                  </div>
                ) : (
                  <div className="ml-auto max-w-[90%] rounded-xl border border-dashed border-line px-2.5 py-1.5 text-[11px] italic text-faint">
                    (no message - {t.action})
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1 text-[9px] font-bold">
                  {t.state.pricePerDay && (
                    <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                      💰 {t.state.pricePerDay} {t.state.currency}/day
                    </span>
                  )}
                  {(t.state.depositType || t.state.depositAmount) && (
                    <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                      🔒 {t.state.depositType === "passport" ? "passport" : ""}
                      {t.state.depositAmount ? ` ${t.state.depositAmount} cash` : ""}
                    </span>
                  )}
                  {t.state.fulfillment && (
                    <span className="rounded-full bg-brandblue-soft px-1.5 py-0.5 text-brandblue">
                      {t.state.fulfillment === "delivery" ? "🛵 delivery" : t.state.fulfillment === "pickup" ? "🚗 pickup" : "🏪 on shop"}
                    </span>
                  )}
                  <span className="rounded-full bg-card2 px-1.5 py-0.5 text-faint">rounds {t.state.rounds}</span>
                  {t.state.firmCount > 0 && (
                    <span className="rounded-full bg-card2 px-1.5 py-0.5 text-faint">firm ×{t.state.firmCount}</span>
                  )}
                  {t.state.dealComplete && (
                    <span className="rounded-full bg-savings-soft px-1.5 py-0.5 text-savings">✅ deal complete</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. The Coach - plain-text lessons that rewrite the live pipeline */}
      <CoachBox />
    </div>
  );
}
