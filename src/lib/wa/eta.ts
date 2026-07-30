// Honest queue ETA (pure, unit-tested).
//
// The UI used to show wa_outbox.not_before verbatim - a LOWER BOUND ("not
// before") presented as a point estimate. After a row is due the anti-ban drain
// still adds: the min-gap between sends (x a stealth multiplier), the per-drain
// cold-intro budget (only ~2 cold sends leave per drain), and the gap until the
// next drain opportunity. So "~10:20" routinely became 10:23 - a trust bug.
//
// This computes an honest ENVELOPE [etaFrom, etaTo] per row by SIMULATING those
// delays over the queue position. It deliberately BOUNDS the drain rather than
// replaying wa-guard's exact branch logic (which would be a maintenance trap):
// etaFrom is the earliest a row could realistically leave, etaTo pads for the
// slower branches (jitter, re-stamp, business-hours). The UI shows the range.

import { classifyQueueReason } from "../queue-reason";

export interface EtaRow {
  id: number;
  notBeforeMs: number;
  kind: string | null; // rfq | custom | human-manual | reply | ...
  rawReason: string | null;
}

export interface EtaContext {
  nowMs: number;
  lastSendAtMs: number | null;
  minGapSec: number; // policies.min_gap_seconds (cold lane)
  gapJitterSec: number; // policies.gap_jitter_seconds
  stealth: number; // 1 healthy | ~1.5 pacing | ~2.5 paused
  introRemaining: number; // newContactBudget remaining cold sends
  introNextFreeAtMs: number | null; // when the intro window frees up
  coldPerDrain?: number; // default 2 (wa-guard cold budget per invocation)
  drainCadenceMs?: number; // default 60_000 (scheduler/tick cadence)
}

export interface EtaWindow {
  etaFromMs: number;
  etaToMs: number;
  overdue: boolean;
}

const COLD_KINDS = new Set(["rfq", "custom", "human-manual"]);

function isColdKind(kind: string | null): boolean {
  // Cold intros are the budgeted, slower lane; everything else (engaged replies)
  // paces on the tighter lane. Unknown kind -> treat as cold (conservative).
  return kind == null || COLD_KINDS.has(kind);
}

/** Compute an ETA envelope per row. Deterministic; etaTo >= etaFrom >= now, and
 * later queue positions never resolve earlier than earlier ones. */
export function computeQueueEtas(rows: EtaRow[], ctx: EtaContext): Map<number, EtaWindow> {
  const coldPerDrain = Math.max(1, ctx.coldPerDrain ?? 2);
  const drainCadenceMs = Math.max(1000, ctx.drainCadenceMs ?? 60_000);
  const stealth = Math.max(1, ctx.stealth || 1);
  const gapMs = Math.max(0, ctx.minGapSec) * 1000 * stealth;
  const jitterMs = Math.max(0, ctx.gapJitterSec) * 1000 * stealth;

  const sorted = [...rows].sort((a, b) => a.notBeforeMs - b.notBeforeMs);
  const out = new Map<number, EtaWindow>();

  // The soonest the NEXT send can leave, given the last send + min-gap.
  let cursor = Math.max(ctx.nowMs, (ctx.lastSendAtMs ?? 0) + gapMs);
  let coldSeen = 0;

  for (const row of sorted) {
    const cold = isColdKind(row.kind);
    let from = Math.max(row.notBeforeMs, cursor);

    if (cold) {
      // Cold intros beyond the remaining budget wait for the window to free.
      if (coldSeen >= ctx.introRemaining && ctx.introNextFreeAtMs) {
        from = Math.max(from, ctx.introNextFreeAtMs);
      }
      // Only coldPerDrain cold sends leave per drain: every full group pushes a
      // whole drain cadence forward.
      from = Math.max(from, cursor + Math.floor(coldSeen / coldPerDrain) * drainCadenceMs);
      coldSeen += 1;
    }

    // Upper bound: the slower drain branches, keyed on the SAME classifier
    // the labels use - two divergent regexes once disagreed about the same
    // row ("shop is closed now" carried an overnight park but matched the
    // tight 4-minute cold pad, so a 10-hour wait rendered as "~05:38-05:44").
    // Hour-scale holds (opening roll + 40min jitter, caps, recovery, breaker
    // freezes) get the wide pad; everything else keeps the tight ones.
    const holdKind = classifyQueueReason(row.rawReason);
    const wide =
      holdKind === "closed" ||
      holdKind === "limit" ||
      holdKind === "breaker" ||
      holdKind === "tomorrow";
    const kindPadMs = wide ? 40 * 60_000 : cold ? 4 * 60_000 : 90_000;
    const to = from + jitterMs + drainCadenceMs + kindPadMs;

    out.set(row.id, { etaFromMs: from, etaToMs: to, overdue: row.notBeforeMs <= ctx.nowMs });

    // Advance the cursor past this send by at least one min-gap.
    cursor = Math.max(cursor, from) + gapMs;
  }

  return out;
}
