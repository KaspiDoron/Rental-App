"use client";

// One negotiation exactly as it happened, with the full "why" behind every
// agent message: director ladder, stage-by-stage execution (with latency),
// judge scores, price impact - and the owner's review controls inline.
// Master-detail: bubbles read like WhatsApp; tapping "Why + review" on an
// agent message unfolds its decision record right under it.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { ReviewControls } from "./ReviewControls";
import type { LadderRung } from "@/app/api/admin/ops/transcript/route";

interface Msg {
  id: string;
  dir: "in" | "out";
  text: string;
  english?: string;
  kind?: string;
  decisionId: string | null;
  nodeId: string | null;
  round: number | null;
  at: string;
}

interface Stage {
  stage: string;
  input: string;
  reasoning: string;
  output: string;
  verdict: string | null;
  nodeId: string | null;
  edgeId: string | null;
  ms: number | null;
}

interface Decision {
  stages: Stage[];
  ladder: LadderRung[];
  specRev: number | null;
  totalMs: number;
  at: string | null;
}

interface ScoreRow {
  decision_id: string | null;
  scorer: string;
  scores: Record<string, number> | null;
  verdict: string | null;
}

interface ReviewRow {
  id: number;
  decision_id: string | null;
  rating: number | null;
  verdict: "approve" | "reject" | null;
  branch_correct: boolean | null;
  outcome_impact: "improved" | "worsened" | "neutral" | null;
  better_response: string | null;
  feedback: string | null;
  tags: string[] | null;
  bookmark: boolean;
  status: string;
  source: string;
  auto_reason: string | null;
}

interface Transcript {
  threadKey: string;
  userEmail: string;
  thread: { phase: string; fields: Record<string, unknown>; waitingUntil: string | null } | null;
  messages: Msg[];
  decisions: Record<string, Decision>;
  scores: ScoreRow[];
  reviews: ReviewRow[];
  offers: {
    price_per_day: number;
    list_price_per_day: number | null;
    currency: string;
    round: number | null;
    verified: boolean | null;
    created_at: string;
  }[];
  queued: { text: string; at: string; reason?: string }[];
}

export function ConversationPanel({
  threadKey,
  vendorName,
  onBack,
}: {
  threadKey: string;
  vendorName: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<Transcript | null>(null);
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  // The shop message the owner says we misread. One per panel session -
  // a correction is about ONE message, not a vague "this went badly".
  const [pinned, setPinned] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goldenNote, setGoldenNote] = useState<string | null>(null);

  const addToGolden = async () => {
    setGoldenNote("Freezing this conversation...");
    try {
      const res = await fetch("/api/admin/ops/golden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-from-thread",
          threadKey,
          name: `${vendorName} - ${new Date().toISOString().slice(0, 10)}`,
        }),
      });
      const d = await res.json();
      setGoldenNote(
        d?.ok
          ? `Frozen as a golden case (${d.turnCount} turns) - every future change must keep it green.`
          : d?.error ?? "Could not create the case."
      );
    } catch {
      setGoldenNote("Could not reach the server.");
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/ops/transcript?threadKey=${encodeURIComponent(threadKey)}`
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "load failed");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the conversation.");
    }
  }, [threadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="surface rounded-blob p-4">
        <button onClick={onBack} className="btn btn-ghost btn-sm rounded-xl">‹ Back</button>
        <p className="mt-2 text-[12px] text-brandred">{error}</p>
      </div>
    );
  }
  if (!data) return <LoadingDots label="Loading the full negotiation" />;

  const f = (data.thread?.fields ?? {}) as {
    pricePerDay?: number;
    currency?: string;
    rounds?: number;
    firmCount?: number;
    declined?: boolean;
    lastTarget?: number;
  };
  const reviewFor = (decisionId: string | null) =>
    data.reviews.find((r) => r.decision_id === decisionId) ?? null;
  const scoresFor = (decisionId: string) =>
    data.scores.filter((s) => s.decision_id === decisionId);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="surface rounded-blob p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <button onClick={onBack} className="text-[11px] font-extrabold text-brandblue">
              ‹ All conversations
            </button>
            <h3 className="truncate text-[15px] font-extrabold text-strong">{vendorName}</h3>
            <p className="truncate text-[11px] text-faint">
              {data.userEmail} · {data.thread?.phase ?? "no state"}
            </p>
            <button
              onClick={addToGolden}
              className="mt-1 chip rounded-full border border-line px-2.5 py-1 text-[10px] font-extrabold text-soft"
            >
              🏅 Add to golden set
            </button>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {f.pricePerDay ? (
              <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                {f.currency ?? ""} {f.pricePerDay}/day
              </span>
            ) : null}
            {typeof f.rounds === "number" && (
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                round {f.rounds}
              </span>
            )}
            {(f.firmCount ?? 0) > 0 && (
              <span className="rounded-full bg-brandyellow-soft px-2 py-0.5 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                firm ×{f.firmCount}
              </span>
            )}
            {f.declined && (
              <span className="rounded-full bg-brandred-soft px-2 py-0.5 text-[10px] font-extrabold text-brandred">
                declined
              </span>
            )}
          </div>
        </div>

        {goldenNote && <p className="mt-1.5 text-[11px] font-bold text-savings">{goldenNote}</p>}

        {/* Price impact timeline */}
        {data.offers.length > 0 && (
          <div className="no-scrollbar mt-2 flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 text-[10px] font-extrabold uppercase tracking-wide text-faint">
              Price path
            </span>
            {data.offers.map((o, i) => {
              const prev = i > 0 ? data.offers[i - 1].price_per_day : o.list_price_per_day;
              const delta =
                prev && prev > 0 ? Math.round(((o.price_per_day - prev) / prev) * 100) : null;
              return (
                <span
                  key={`${o.created_at}${i}`}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-card2 px-2 py-0.5 text-[10px] font-bold text-soft"
                >
                  {i > 0 && <span className="text-faint">→</span>}
                  {o.currency} {o.price_per_day}
                  {delta != null && delta !== 0 && (
                    <span className={delta < 0 ? "text-savings" : "text-brandred"}>
                      {delta > 0 ? "+" : ""}
                      {delta}%
                    </span>
                  )}
                  {o.round != null && <span className="text-faint">r{o.round}</span>}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Transcript with inline decision records */}
      <div className="surface rounded-blob p-3.5">
        <div className="space-y-2">
          {data.messages.length === 0 && (
            <p className="py-4 text-center text-[12px] text-faint">No messages in this thread yet.</p>
          )}
          {data.messages.map((m) => {
            const decision = m.decisionId ? data.decisions[m.decisionId] : null;
            const open = openDecision === m.id;
            return (
              <div key={m.id}>
                <div className={`flex ${m.dir === "out" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                      m.dir === "out"
                        ? "rounded-br-md bg-brandblue text-white"
                        : "rounded-bl-md bg-card text-strong"
                    }`}
                  >
                    {m.kind && (
                      <div className={`text-[9px] font-extrabold uppercase tracking-wide ${m.dir === "out" ? "text-white/70" : "text-faint"}`}>
                        {m.kind.replace(/^auto-/, "")}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words text-[13px]">{m.text}</p>
                    {m.english && m.english !== m.text && (
                      <p
                        className={`mt-1 border-t pt-1 text-[11px] ${
                          m.dir === "out"
                            ? "border-white/20 text-white/80"
                            : "border-line text-soft"
                        }`}
                      >
                        🌐 {m.english}
                      </p>
                    )}
                    <div className={`mt-1 flex items-center gap-2 text-[9px] ${m.dir === "out" ? "text-white/60" : "text-faint"}`}>
                      <span>{new Date(m.at).toLocaleString()}</span>
                      {/* Only a SHOP message can be misread by us. Pinning one
                          is what turns "this thread went wrong" into a
                          correction the engine can actually compile. */}
                      {m.dir === "in" && m.text?.trim() && (
                        <button
                          onClick={() => setPinned(pinned === m.text ? null : m.text)}
                          className={`font-extrabold underline ${pinned === m.text ? "text-brandblue" : ""}`}
                        >
                          {pinned === m.text ? "📌 Pinned as misread" : "📌 Agent misread this"}
                        </button>
                      )}
                      {m.decisionId && decision && (
                        <button
                          onClick={() => setOpenDecision(open ? null : m.id)}
                          className="font-extrabold underline"
                        >
                          {open ? "Hide decision" : "🔬 Why + review"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Decision record: ladder, execution, judge, review */}
                {open && decision && m.decisionId && (
                  <DecisionRecord
                    decisionId={m.decisionId}
                    decision={decision}
                    scores={scoresFor(m.decisionId)}
                    review={reviewFor(m.decisionId)}
                    threadKey={data.threadKey}
                    pinnedMessage={pinned}
                    onSaved={load}
                  />
                )}
              </div>
            );
          })}
          {data.queued.map((q, i) => (
            <div key={`q${i}`} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border-2 border-dashed border-line bg-card2 px-3 py-2">
                <div className="text-[9px] font-extrabold uppercase tracking-wide text-faint">
                  Queued to send{q.reason ? ` - ${q.reason}` : ""}
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px] text-soft">{q.text}</p>
                <div className="mt-1 text-[9px] text-faint">{new Date(q.at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Thread-level review */}
      <div className="surface rounded-blob p-3.5">
        <h4 className="mb-2 text-[13px] font-extrabold text-strong">
          🧑‍⚖️ Whole-negotiation review
        </h4>
        <ReviewControls
          threadKey={data.threadKey}
          decisionId={null}
          initial={reviewFor(null)}
          pinnedMessage={pinned}
          onSaved={load}
        />
      </div>
    </div>
  );
}

function DecisionRecord({
  decisionId,
  decision,
  scores,
  review,
  threadKey,
  pinnedMessage,
  onSaved,
}: {
  decisionId: string;
  decision: Decision;
  scores: ScoreRow[];
  review: ReviewRow | null;
  threadKey: string;
  pinnedMessage?: string | null;
  onSaved: () => void;
}) {
  const [view, setView] = useState<"ladder" | "trace" | "review" | "rule">("ladder");
  return (
    <div className="mb-1 ml-2 mt-1 rounded-2xl border border-line bg-card2 p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {(["ladder", "trace", "review", "rule"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`btn btn-sm rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
              view === v ? "bg-brandblue text-white" : "text-soft hover:bg-card"
            }`}
          >
            {v === "ladder" ? "🪜 Why this move" : v === "trace" ? "⚙️ Execution" : v === "review" ? "⭐ Review" : "➕ Rule"}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-[9px] text-faint">
          {decision.totalMs > 0 && <span>{(decision.totalMs / 1000).toFixed(1)}s</span>}
          {decision.specRev != null && (
            <span className="rounded-full bg-card px-1.5 py-0.5 font-extrabold">
              rev {decision.specRev}
            </span>
          )}
          <span className="font-mono">{decisionId.slice(0, 8)}</span>
        </span>
      </div>

      {view === "ladder" && (
        <div className="space-y-1">
          {decision.ladder.length === 0 && (
            <p className="text-[11px] text-faint">No ladder trace for this decision.</p>
          )}
          {decision.ladder.map((r) => (
            <div
              key={r.e}
              className={`rounded-xl border px-2 py-1.5 text-[11px] ${
                r.chosen
                  ? "border-brandblue bg-brandblue-soft"
                  : r.legal
                    ? "border-line bg-card"
                    : "border-transparent bg-card opacity-55"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span>{r.chosen ? "✅" : r.legal ? "🔵" : "⬜"}</span>
                <span className="font-extrabold text-strong">{r.l}</span>
                <span className="ml-auto rounded-full bg-card2 px-1.5 text-[9px] font-bold text-faint">
                  {r.chosen ? "CHOSEN" : r.legal ? "possible" : "skipped"}
                </span>
              </div>
              <p className="mt-0.5 text-soft">{r.why}</p>
            </div>
          ))}
        </div>
      )}

      {view === "trace" && (
        <div className="space-y-1">
          {decision.stages.map((s, i) => (
            <div key={i} className="rounded-xl bg-card px-2 py-1.5 text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-strong">{s.stage}</span>
                {s.verdict && (
                  <span className="rounded-full bg-brandyellow-soft px-1.5 text-[9px] font-bold text-[#8a6100] dark:text-brandyellow">
                    {s.verdict}
                  </span>
                )}
                {typeof s.ms === "number" && (
                  <span className="ml-auto text-[9px] text-faint">{s.ms}ms</span>
                )}
              </div>
              {s.reasoning && <p className="mt-0.5 text-soft">why: {s.reasoning}</p>}
              {s.output && <p className="mt-0.5 text-faint">out: {s.output}</p>}
            </div>
          ))}
          {scores.length > 0 && (
            <div className="rounded-xl bg-card px-2 py-1.5 text-[11px]">
              <span className="font-extrabold text-strong">Judge</span>
              {scores.map((s, i) => (
                <div key={i} className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-brandblue-soft px-1.5 text-[9px] font-bold text-brandblue">
                    {s.scorer}
                  </span>
                  {Object.entries(s.scores ?? {}).map(([k, v]) =>
                    typeof v === "number" ? (
                      <span key={k} className="text-[10px] text-soft">
                        {k} <b className="text-strong">{v}</b>
                      </span>
                    ) : null
                  )}
                  {s.verdict && <p className="w-full text-[10px] text-faint">{s.verdict}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "review" && (
        <ReviewControls
          threadKey={threadKey}
          decisionId={decisionId}
          initial={review}
          pinnedMessage={pinnedMessage}
          onSaved={onSaved}
        />
      )}

      {view === "rule" && <RuleForm decisionId={decisionId} />}
    </div>
  );
}

// Create a new branching rule straight from this real situation - it lands as
// a typed director edge (sanitized + validated + golden-gated + versioned).
function RuleForm({ decisionId }: { decisionId: string }) {
  const [to, setTo] = useState("bargain");
  const [label, setLabel] = useState("");
  const [priority, setPriority] = useState(500);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      let cond: unknown;
      if (when.trim()) {
        try {
          cond = JSON.parse(when);
        } catch {
          setNote("The condition is not valid JSON.");
          setBusy(false);
          return;
        }
      }
      const res = await fetch("/api/admin/ops/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromDecisionId: decisionId,
          edge: { to, label, when: cond, priority },
          note: `from decision ${decisionId.slice(0, 8)}`,
        }),
      });
      const d = await res.json();
      setNote(
        d?.ok
          ? `Rule applied as edge ${d.edgeId} (version ${d.versionId ?? "-"}) - golden suite green.`
          : d?.error ?? "Rule rejected."
      );
    } catch {
      setNote("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-soft">
        New director edge, born from this exact situation. It must pass validation AND the
        golden suite before it goes live; fine-tune it later in the Pipeline Studio.
      </p>
      <div className="flex gap-1.5">
        <label className="min-w-0 flex-1">
          <span className="text-[9px] font-extrabold uppercase text-faint">Target node</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="bargain / clarify / close / deposit-probe..."
            className="h-9 w-full rounded-xl border-2 border-line bg-card px-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
          />
        </label>
        <label className="w-20 shrink-0">
          <span className="text-[9px] font-extrabold uppercase text-faint">Priority</span>
          <input
            type="number"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="h-9 w-full rounded-xl border-2 border-line bg-card px-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
          />
        </label>
      </div>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Rule name, e.g. 'push again when rival is cheaper'"
        className="h-9 w-full rounded-xl border-2 border-line bg-card px-2 text-[12px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />
      <textarea
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        rows={2}
        placeholder='Condition JSON, e.g. {"kind":"allG","of":[{"kind":"rivalCheaper"},{"kind":"priceFarAboveFloor"}]} - empty = always legal'
        className="w-full rounded-xl border-2 border-line bg-card px-2 py-1.5 font-mono text-[10px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !label.trim() || !to.trim()}
          className="btn btn-primary btn-sm rounded-xl px-3"
        >
          {busy ? "Gating..." : "Validate, gate & apply"}
        </button>
        {note && <p className="text-[10px] font-bold text-soft">{note}</p>}
      </div>
    </div>
  );
}
