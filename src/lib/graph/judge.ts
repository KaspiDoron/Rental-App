// The Judge team - scores the agents' moves so the system learns and the owner
// sees quality longitudinally. Never runs inline in the reply path: the engine
// enqueues a graph_wakeups {kind:"judge"} row (+90s) after each delivery, and a
// cheap later invocation (usually a user's own poll) runs this.
//
//   move judge   - grades one outbound (tacticFit / tone / uniqueness, 1-5)
//   chief judge  - per thread/session: aggregates + HARD outcome math
//                  (discount %, floor gap, deal complete) + a coaching verdict
//
// Research-backed: pointwise criterion-separated rubrics beat vague "grade
// this"; a one-line justification per verdict; prefer a DIFFERENT provider than
// the composer (family-bias); a versioned rubric. All degrade to deterministic
// rule-scores with no LLM key.

import "server-only";
import { chatDetailed, extractJson } from "../ai";
import { sbInsert, sbSelect } from "../runtime-config";
import { trigramOverlap } from "./uniqueness";
import { getActiveRev } from "../ops/rev";
import type { ScoreRecord } from "./types";

export const JUDGE_RUBRIC_VERSION = "v1" as const;

const EMOJI_ANY = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u;

async function persistScore(rec: ScoreRecord): Promise<void> {
  const row = {
    decision_id: rec.decisionId,
    thread_key: rec.threadKey,
    node_id: rec.nodeId,
    scorer: rec.scorer,
    rubric_version: rec.rubricVersion,
    scores: rec.scores,
    tactic_id: rec.tacticId ?? null,
    provider: rec.provider ?? null,
    verdict: rec.verdict,
    spec_rev: await getActiveRev().catch(() => null),
  };
  // Same silent-fail-on-unknown-column hazard as agent_traces: retry without
  // the Ops column so scores never vanish before the migration runs.
  const ok = await sbInsert("agent_scores", [row]).catch(() => false);
  if (ok === false) {
    const { spec_rev: _s, ...bare } = row;
    await sbInsert("agent_scores", [bare]).catch(() => {});
  }
}

/** Deterministic move scores - the always-available floor. */
function deterministicMoveScores(
  text: string,
  recentGlobal: string[]
): { tacticFit: number; tone: number; uniqueness: number } {
  const hasEmoji = EMOJI_ANY.test(text);
  const tooLong = text.length > 320;
  const pushy = /\b(you must|final offer|last chance|right now|immediately)\b/i.test(text);
  let maxOverlap = 0;
  for (const p of recentGlobal) maxOverlap = Math.max(maxOverlap, trigramOverlap(text, p));
  return {
    tacticFit: 3,
    tone: hasEmoji && !pushy && !tooLong ? 4 : pushy ? 2 : 3,
    uniqueness: maxOverlap < 0.5 ? 5 : maxOverlap < 0.75 ? 3 : 1,
  };
}

async function scoreMove(args: {
  decisionId: string;
  threadKey: string;
  nodeId: string;
  tacticId?: string;
  text: string;
  kind: string;
  history: string;
}): Promise<ScoreRecord> {
  const recent = await sbSelect<{ body: string | null }>(
    "whatsapp_messages",
    `select=body&direction=eq.outbound&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=60`
  )
    .then((rows) => rows.map((r) => r.body ?? "").filter(Boolean))
    .catch(() => []);
  const det = deterministicMoveScores(args.text, recent);

  // Owner calibration: the judge re-anchors its rubric to how the OWNER
  // grades similar messages (compiled from Ops Center reviews; empty when
  // nothing is learned or the kill switch is off).
  let calibration = "";
  try {
    const { getOpsLearning, formatJudgeCalibration } = await import("../ops/learning");
    calibration = formatJudgeCalibration(await getOpsLearning());
  } catch {
    /* calibration is optional context */
  }

  const detail = await chatDetailed([
    {
      role: "system",
      content:
        "You are a strict evaluator of ONE WhatsApp message a rental-negotiation agent sent " +
        "on a traveller's behalf. Score three criteria from 1 (poor) to 5 (excellent), each " +
        "with a SHORT reason:\n" +
        "- tacticFit: did the move fit the situation (e.g. probing the deposit once a price is " +
        "known, not pushing when the shop is firm, never implying acceptance)?\n" +
        "- tone: warm, human, casual, non-pushy, exactly one emoji, not too long?\n" +
        "- uniqueness: does it read as freshly written, not a canned template?\n" +
        'Reply ONLY as JSON: { "tacticFit": 1-5, "tone": 1-5, "uniqueness": 1-5, "why": string }.' +
        calibration,
    },
    {
      role: "user",
      content: `Move type: ${args.kind}\nConversation so far:\n${args.history}\n\nThe agent's message: ${args.text}`,
    },
  ]);
  const parsed = detail.text
    ? extractJson<{ tacticFit?: number; tone?: number; uniqueness?: number; why?: string }>(
        detail.text
      )
    : null;

  const clamp = (v: unknown, fallback: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x >= 1 && x <= 5 ? x : fallback;
  };
  const scores = parsed
    ? {
        tacticFit: clamp(parsed.tacticFit, det.tacticFit),
        tone: clamp(parsed.tone, det.tone),
        uniqueness: clamp(parsed.uniqueness, det.uniqueness),
      }
    : det;
  const rec: ScoreRecord = {
    decisionId: args.decisionId,
    threadKey: args.threadKey,
    nodeId: args.nodeId,
    scorer: parsed ? "move-judge" : "deterministic",
    rubricVersion: JUDGE_RUBRIC_VERSION,
    scores,
    tacticId: args.tacticId,
    provider: parsed ? detail.provider : undefined,
    verdict: (parsed?.why ?? "deterministic rule scores").slice(0, 300),
  };
  await persistScore(rec);
  return rec;
}

/** Per-thread chief judgment: hard outcome math + coaching verdict + learning. */
async function judgeThread(threadKey: string): Promise<ScoreRecord | null> {
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return null;
  const userEmail = threadKey.slice(0, idx);
  const toDigits = threadKey.slice(idx + 1);

  // The offers this user got from this shop in the recent session window.
  const offers = await sbSelect<{
    price_per_day: number;
    list_price_per_day: number | null;
    currency: string;
    created_at: string;
  }>(
    "offers",
    `select=price_per_day,list_price_per_day,currency,created_at&user_email=eq.${encodeURIComponent(
      userEmail
    )}&vendor_id=eq.${encodeURIComponent(toDigits)}&simulated=eq.false&order=created_at.asc&limit=10`
  ).catch(() => []);

  // Thread state for completeness + rounds + floor gap.
  const threads = await sbSelect<{ fields: Record<string, unknown> | null; phase: string }>(
    "negotiation_threads",
    `select=fields,phase&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
  ).catch(() => []);
  const f = (threads[0]?.fields ?? {}) as {
    pricePerDay?: number;
    depositType?: string;
    depositNote?: string;
    fulfillment?: string;
    rounds?: number;
  };

  const firstQuote = offers[0]?.list_price_per_day || offers[0]?.price_per_day;
  const finalPrice = f.pricePerDay ?? offers[offers.length - 1]?.price_per_day;
  const discountPct =
    firstQuote && finalPrice && firstQuote > 0
      ? Math.max(0, Math.round(((firstQuote - finalPrice) / firstQuote) * 100))
      : 0;
  const complete = Boolean(
    f.pricePerDay && (f.depositType || f.depositNote) && f.fulfillment
  );
  // outcomeDelta on a 1-5 scale: a real discount + a complete deal is a 5.
  const outcomeDelta = Math.max(
    1,
    Math.min(5, 1 + Math.round(discountPct / 8) + (complete ? 1 : 0))
  );

  const moveScores = await sbSelect<{ scores: Record<string, number> }>(
    "agent_scores",
    `select=scores&thread_key=eq.${encodeURIComponent(
      threadKey
    )}&scorer=neq.chief-judge&order=created_at.desc&limit=20`
  ).catch(() => []);
  const avg = (k: string) => {
    const vals = moveScores.map((m) => m.scores?.[k]).filter((x) => typeof x === "number");
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : undefined;
  };

  const verdict = `discount ${discountPct}% over ${f.rounds ?? 0} round(s); deal ${
    complete ? "complete" : "incomplete"
  }; avg tone ${avg("tone") ?? "-"}, tacticFit ${avg("tacticFit") ?? "-"}.`;

  const rec: ScoreRecord = {
    decisionId: `chief-${threadKey}`,
    threadKey,
    nodeId: "director",
    scorer: "chief-judge",
    rubricVersion: JUDGE_RUBRIC_VERSION,
    scores: {
      tacticFit: avg("tacticFit"),
      tone: avg("tone"),
      uniqueness: avg("uniqueness"),
      outcomeDelta,
    },
    verdict,
  };
  await persistScore(rec);

  // Feed tactic learning: every bargain tactic used in this thread gets the
  // realized outcome (won = a real discount landed). Durable EMA in memory.ts.
  try {
    const { recordOutcome, hydrateTactics } = await import("../memory");
    await hydrateTactics();
    const drafts = await sbSelect<{ tactic: string }>(
      "bargain_drafts",
      `select=tactic&user_email=eq.${encodeURIComponent(
        userEmail
      )}&vendor_id=eq.${encodeURIComponent(toDigits)}&order=created_at.desc&limit=5`
    ).catch(() => []);
    for (const d of drafts) {
      if (d.tactic) recordOutcome(d.tactic, discountPct > 0, discountPct);
    }
  } catch {
    /* learning is best-effort */
  }
  return rec;
}

/** Wakeup dispatcher (called from drainGraphWakeups). */
export async function runJudgeJob(
  kind: "judge" | "session-judge",
  threadKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (kind === "judge") {
    const text = String(payload.text ?? "");
    if (!text) return;
    // Reconstruct a light history for context (best-effort).
    const idx = threadKey.lastIndexOf(":");
    const toDigits = idx > 0 ? threadKey.slice(idx + 1) : "";
    const rows = await sbSelect<{ direction: string; body: string | null }>(
      "whatsapp_messages",
      `select=direction,body&or=(to_number.eq.${encodeURIComponent(
        toDigits
      )},from_number.eq.${encodeURIComponent(toDigits)})&order=received_at.desc&limit=8`
    ).catch(() => []);
    const history = rows
      .reverse()
      .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 200)}`)
      .join("\n");
    await scoreMove({
      decisionId: String(payload.decisionId ?? ""),
      threadKey,
      nodeId: String(payload.nodeId ?? ""),
      tacticId: payload.tacticId ? String(payload.tacticId) : undefined,
      text,
      kind: String(payload.kind ?? "move"),
      history,
    });
    return;
  }
  await judgeThread(threadKey);
}

/** Owner-facing: recent scores + per-tactic learning table (Studio Scores tab). */
export async function scoresSummary(): Promise<{
  recent: {
    thread_key: string;
    node_id: string;
    scorer: string;
    scores: Record<string, number>;
    verdict: string;
    created_at: string;
  }[];
  tactics: import("../types").NegotiationTactic[];
}> {
  const recent = await sbSelect<{
    thread_key: string;
    node_id: string;
    scorer: string;
    scores: Record<string, number>;
    verdict: string;
    created_at: string;
  }>(
    "agent_scores",
    "select=thread_key,node_id,scorer,scores,verdict,created_at&order=created_at.desc&limit=40"
  ).catch(() => []);
  const { getTactics, hydrateTactics } = await import("../memory");
  await hydrateTactics();
  return { recent, tactics: getTactics() };
}
