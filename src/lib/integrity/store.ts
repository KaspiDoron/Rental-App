// Durable side of the integrity ladder, on the table that already exists.
//
// `user_cooldowns` is already soft, already expiring and already carries a
// reason - which is exactly the shape a graduated ladder needs, so there is no
// migration here. Signals ride in the reason field as compact JSON; a row that
// has lapsed simply stops counting, which is the decay the pure layer expects.

import "server-only";
import {
  assessIntegrity,
  signalsIn,
  liveSignals,
  requiresOwnerApproval,
  SIGNAL_TTL_MS,
  type IntegritySignal,
  type IntegrityVerdict,
} from "./signals";
import { PROPOSAL_EVENT } from "./adjudication";

const KIND = "integrity";

interface Stored {
  signals: IntegritySignal[];
}

function parse(reason: string | null | undefined): IntegritySignal[] {
  if (!reason) return [];
  try {
    const j = JSON.parse(reason) as Stored;
    return Array.isArray(j?.signals) ? j.signals : [];
  } catch {
    return [];
  }
}

/** Every live signal for this traveller. Never throws. */
export async function loadSignals(email: string, nowMs: number): Promise<IntegritySignal[]> {
  const { sbSelect } = await import("../runtime-config");
  const rows = await sbSelect<{ reason: string | null }>(
    "user_cooldowns",
    `select=reason&email=eq.${encodeURIComponent(
      email.toLowerCase()
    )}&kind=eq.${KIND}&limit=1`
  ).catch(() => [] as { reason: string | null }[]);
  return liveSignals(parse(rows[0]?.reason), nowMs);
}

async function saveSignals(email: string, signals: IntegritySignal[]): Promise<void> {
  const { sbInsert } = await import("../runtime-config");
  await sbInsert(
    "user_cooldowns",
    [
      {
        email: email.toLowerCase(),
        kind: KIND,
        // The row's own expiry is the outer bound of the decay window, so a
        // dormant traveller's history clears itself with no sweeper.
        until: new Date(Date.now() + SIGNAL_TTL_MS).toISOString(),
        reason: JSON.stringify({ signals: signals.slice(-12) } satisfies Stored),
      },
    ],
    "email,kind"
  ).catch(() => {});
}

/**
 * Record whatever this message shows and return where the traveller now stands.
 *
 * The verdict is the ONLY thing callers act on, and nothing above a pause ever
 * happens without a human: the top rung is a proposal queued for the owner,
 * with its evidence attached.
 */
export async function noteAndAssess(opts: {
  email: string;
  plan: string | null | undefined;
  text: string;
  nowMs?: number;
}): Promise<IntegrityVerdict> {
  const now = opts.nowMs ?? Date.now();
  return note(opts.email, opts.plan, signalsIn(opts.text, now), now);
}

/**
 * Record a signal the system OBSERVED rather than read.
 *
 * Not every piece of evidence is prose. A free plan posting a future pickup
 * date straight at `/api/bookings` is the clearest bypass attempt there is, and
 * until this existed it reached the ladder not at all - the server refused the
 * booking and forgot it, so the same traveller could try every hour and never
 * climb a rung. Structural detections are first-class signals, which is what
 * keeps the ladder from depending on regexes over sentences.
 */
export async function recordSignal(opts: {
  email: string;
  plan: string | null | undefined;
  kind: IntegritySignal["kind"];
  evidence: string;
  nowMs?: number;
}): Promise<IntegrityVerdict> {
  const now = opts.nowMs ?? Date.now();
  return note(
    opts.email,
    opts.plan,
    [{ kind: opts.kind, at: now, evidence: String(opts.evidence ?? "").trim().slice(0, 180) }],
    now
  );
}

async function note(
  email: string,
  plan: string | null | undefined,
  fresh: IntegritySignal[],
  now: number
): Promise<IntegrityVerdict> {
  const prior = await loadSignals(email, now);
  const all = [...prior, ...fresh];
  if (fresh.length) await saveSignals(email, all);

  const verdict = assessIntegrity(all, now, plan);

  if (requiresOwnerApproval(verdict.step)) {
    // A PROPOSAL, not an action. The owner sees it in Ops with the evidence and
    // decides; the traveller keeps their deals in the meantime.
    //
    // This row is the AUDIT TRAIL, not the queue. The queue is derived from the
    // signals themselves (lib/integrity/queue), because this insert is
    // fire-and-forget - and a queue built on it would drop a person entirely
    // every time Supabase hiccuped.
    const { sbInsert } = await import("../runtime-config");
    await sbInsert("agent_events", [
      {
        kind: PROPOSAL_EVENT,
        user_email: email,
        vendor_id: "",
        vendor_name: "",
        detail: JSON.stringify({
          score: verdict.score,
          evidence: verdict.evidence,
          proposal: "block",
          note: "Queued for owner approval - no action taken automatically.",
        }),
      },
    ]).catch(() => {});
  }
  return verdict;
}
