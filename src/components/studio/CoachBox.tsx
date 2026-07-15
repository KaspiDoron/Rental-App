"use client";

import { useState } from "react";
import { LoadingDots } from "../LoadingDots";

// The Coach: write what was good / bad (optionally with a 1-5 score) and the
// pipeline updates ITSELF - an agent converts the feedback into instruction
// patches on the right nodes, applies them to the live graph, and reports
// exactly what changed. Lessons are also stored as durable training examples.

interface CoachResult {
  applied?: boolean;
  fromAi?: boolean;
  summary?: string;
  patches?: { nodeId: string; nodeLabel: string; appended: string }[];
  error?: string;
}

export function CoachBox({
  title = "🎓 Teach the pipeline",
  placeholder = "What was good, what was bad, what should change? e.g. \"Never accept a first price near double the floor - always push with the days as leverage first.\"",
  /** Optional run transcript so the Coach knows WHAT it is scoring. */
  context,
}: {
  title?: string;
  placeholder?: string;
  context?: () => string;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CoachResult | null>(null);

  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/graph/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: text.trim(),
          score: score ?? undefined,
          context: context?.() ?? undefined,
        }),
      });
      const d = (await res.json()) as CoachResult;
      setResult(d);
      if (d.applied) setText("");
    } catch {
      setResult({ error: "Could not reach the Coach - check your connection." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-2.5">
      <div className="mb-1 text-[12px] font-extrabold text-strong">{title}</div>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="mr-1 text-[10px] font-bold text-faint">Score:</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setScore(score === n ? null : n)}
            className={`btn btn-sm h-7 w-7 rounded-full border text-[12px] font-extrabold ${
              score === n
                ? "border-brandblue bg-brandblue-soft text-brandblue"
                : "border-line text-faint"
            }`}
          >
            {n}
          </button>
        ))}
        {score && <span className="ml-1 text-[10px] text-faint">{score}/5</span>}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="w-full rounded-xl border-2 border-line bg-card2 p-2 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />
      <button
        onClick={submit}
        disabled={busy || !text.trim()}
        className="btn btn-primary mt-1.5 w-full rounded-xl py-2 text-[13px] font-bold disabled:opacity-50"
      >
        {busy ? <LoadingDots light label="Coaching the agents" /> : "Apply the lesson to the live pipeline"}
      </button>

      {result?.error && (
        <div className="mt-2 rounded-lg bg-brandred/10 p-2 text-[12px] font-bold text-brandred">
          {result.error}
        </div>
      )}
      {result?.applied && (
        <div className="mt-2 rounded-xl bg-savings-soft p-2">
          <div className="text-[12px] font-extrabold text-savings">
            ✅ Applied{result.fromAi ? "" : " (deterministic - no AI key)"}
          </div>
          {result.summary && <div className="mt-0.5 text-[12px] text-soft">{result.summary}</div>}
          {(result.patches ?? []).map((p) => (
            <div key={`${p.nodeId}-${p.appended.slice(0, 12)}`} className="mt-1 text-[11px] text-soft">
              <span className="font-bold text-strong">{p.nodeLabel}</span>: {p.appended}
            </div>
          ))}
          <div className="mt-1 text-[10px] text-faint">
            You can review or edit every change on the node itself (Flow / Pipeline tab).
          </div>
        </div>
      )}
    </div>
  );
}
