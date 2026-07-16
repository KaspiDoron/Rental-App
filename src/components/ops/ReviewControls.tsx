"use client";

// The owner's judgment of one agent decision (or a whole thread): rating,
// approve/reject, branch verdict, outcome impact, correction, feedback, tags,
// bookmark, flag. Every save is real learning - bookmarks and corrections
// become training exemplars immediately, and the aggregate feeds edge priors.

import { useState } from "react";
import type { OutcomeImpact, ReviewVerdict } from "@/lib/ops/types";

interface Initial {
  rating?: number | null;
  verdict?: ReviewVerdict | null;
  branch_correct?: boolean | null;
  outcome_impact?: OutcomeImpact | null;
  better_response?: string | null;
  feedback?: string | null;
  tags?: string[] | null;
  bookmark?: boolean | null;
  status?: string | null;
}

export function ReviewControls({
  threadKey,
  decisionId,
  initial,
  onSaved,
}: {
  threadKey: string;
  decisionId?: string | null;
  initial?: Initial | null;
  onSaved?: () => void;
}) {
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(initial?.verdict ?? null);
  const [branchCorrect, setBranchCorrect] = useState<boolean | null>(
    initial?.branch_correct ?? null
  );
  const [impact, setImpact] = useState<OutcomeImpact | null>(initial?.outcome_impact ?? null);
  const [better, setBetter] = useState(initial?.better_response ?? "");
  const [feedback, setFeedback] = useState(initial?.feedback ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [bookmark, setBookmark] = useState(initial?.bookmark ?? false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [coachBusy, setCoachBusy] = useState(false);

  // Route the feedback through the Coach: an agent converts it into concrete
  // instruction patches on the live pipeline (versioned, rollbackable).
  const applyAsCoaching = async () => {
    if (!feedback.trim()) return;
    setCoachBusy(true);
    setSaved(null);
    try {
      const res = await fetch("/api/admin/graph/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback,
          score: rating ?? undefined,
          context: `Ops Center review of thread ${threadKey}${
            decisionId ? `, decision ${decisionId}` : ""
          }.${better.trim() ? ` Suggested better reply: "${better.trim()}"` : ""}`,
        }),
      });
      const d = await res.json();
      setSaved(
        d?.applied
          ? `Coaching applied: ${d.summary || d.patches?.map((p: { nodeLabel: string }) => p.nodeLabel).join(", ")}`
          : d?.error ?? "Coaching failed."
      );
    } catch {
      setSaved("Could not reach the coach.");
    } finally {
      setCoachBusy(false);
    }
  };

  const save = async (extra?: Record<string, unknown>) => {
    setBusy(true);
    setSaved(null);
    try {
      const res = await fetch("/api/admin/ops/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadKey,
          decisionId: decisionId ?? null,
          ...(rating != null ? { rating } : {}),
          ...(verdict ? { verdict } : {}),
          ...(branchCorrect != null ? { branchCorrect } : {}),
          ...(impact ? { outcomeImpact: impact } : {}),
          betterResponse: better,
          feedback,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          bookmark,
          ...extra,
        }),
      });
      const d = await res.json();
      setSaved(d?.ok ? "Saved - the agents learn from this." : d?.error ?? "Save failed.");
      if (d?.ok) onSaved?.();
    } catch {
      setSaved("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean, tone: "blue" | "red" | "green" = "blue") =>
    `chip rounded-full border px-2.5 py-1 text-[11px] font-extrabold ${
      active
        ? tone === "red"
          ? "border-brandred bg-brandred-soft text-brandred"
          : tone === "green"
            ? "border-savings bg-savings-soft text-savings"
            : "border-brandblue bg-brandblue-soft text-brandblue"
        : "border-line text-soft"
    }`;

  return (
    <div className="space-y-2.5">
      {/* Rating + verdict */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setRating(rating === n ? null : n)}
              className={`text-[18px] leading-none ${
                rating != null && n <= rating ? "" : "opacity-25 grayscale"
              }`}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
            >
              ⭐
            </button>
          ))}
        </div>
        <button
          onClick={() => setVerdict(verdict === "approve" ? null : "approve")}
          className={chip(verdict === "approve", "green")}
        >
          ✓ Approve
        </button>
        <button
          onClick={() => setVerdict(verdict === "reject" ? null : "reject")}
          className={chip(verdict === "reject", "red")}
        >
          ✗ Reject
        </button>
      </div>

      {/* Branch + outcome verdicts (decision-level learning signals) */}
      {decisionId && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-extrabold uppercase tracking-wide text-faint">
            Branch
          </span>
          <button
            onClick={() => setBranchCorrect(branchCorrect === true ? null : true)}
            className={chip(branchCorrect === true, "green")}
          >
            Correct move
          </button>
          <button
            onClick={() => setBranchCorrect(branchCorrect === false ? null : false)}
            className={chip(branchCorrect === false, "red")}
          >
            Wrong move
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-extrabold uppercase tracking-wide text-faint">
          Outcome
        </span>
        {(["improved", "worsened", "neutral"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setImpact(impact === v ? null : v)}
            className={chip(impact === v, v === "improved" ? "green" : v === "worsened" ? "red" : "blue")}
          >
            {v}
          </button>
        ))}
      </div>

      {/* Correction - what SHOULD have been sent */}
      <textarea
        value={better}
        onChange={(e) => setBetter(e.target.value)}
        placeholder="What the agent SHOULD have sent (becomes a training correction)..."
        rows={2}
        className="w-full rounded-xl border-2 border-line bg-card px-2.5 py-1.5 text-[12px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Why was this good or bad? (feeds the coaching loop)"
        rows={2}
        className="w-full rounded-xl border-2 border-line bg-card px-2.5 py-1.5 text-[12px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags, comma-separated (missed-leverage, tone, extraction...)"
        className="w-full rounded-xl border-2 border-line bg-card px-2.5 py-1.5 text-[12px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setBookmark(!bookmark)} className={chip(bookmark, "green")}>
          {bookmark ? "🔖 Bookmarked exemplar" : "🔖 Bookmark as exemplar"}
        </button>
        <button
          onClick={() => save({ status: "flagged" })}
          disabled={busy}
          className={chip(initial?.status === "flagged", "red")}
        >
          🚩 Flag for later
        </button>
        {(initial?.status === "auto_flagged" || initial?.status === "flagged") && (
          <button onClick={() => save({ status: "resolved" })} disabled={busy} className={chip(false)}>
            Resolve
          </button>
        )}
        {feedback.trim() && (
          <button
            onClick={applyAsCoaching}
            disabled={coachBusy}
            className="btn btn-ghost btn-sm rounded-xl px-3"
            title="An agent turns this feedback into instruction patches on the live pipeline"
          >
            {coachBusy ? "Coaching..." : "🎓 Apply as coaching"}
          </button>
        )}
        <button
          onClick={() => save()}
          disabled={busy}
          className="btn btn-primary btn-sm ml-auto rounded-xl px-4"
        >
          {busy ? "Saving..." : "Save review"}
        </button>
      </div>
      {saved && <p className="text-[11px] font-bold text-savings">{saved}</p>}
    </div>
  );
}
