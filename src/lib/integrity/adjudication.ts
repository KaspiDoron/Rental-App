// OWNER ADJUDICATION - the missing half of the graduated ladder.
//
// The ladder learned to PROPOSE a block. It never learned what a DECISION is.
// With no way to represent "the owner looked at this and said yes/no", there
// was no decision for anything to consult - so the only code that could act
// acted on the proposal itself: `api/outreach` refused every send from anyone
// who reached the top rung, for as long as the evidence stayed live, while the
// comment four lines above it promised that nothing bans by itself. The
// proposal was written to `agent_events` and read by NOTHING in the repo.
//
// The missing capability is a decision record with three properties:
//
//   1. It is DURABLE and attributable - who decided, when, on what evidence.
//   2. It EXPIRES against new evidence. A rejection settles what the owner
//      saw; it can never settle a traveller's future. So a case re-opens the
//      moment a signal arrives that is newer than the decision - no sweeper,
//      no "re-flag" special case, just a comparison of two timestamps.
//   3. It is SEPARATE from the thing that enforces. A rung of the ladder is a
//      pause with a duration. An owner-approved restriction is a cooldown row.
//      Nothing else in the system is allowed to block a send.
//
// PURE (no clock, no database) so the state machine is visible and testable in
// one place; `queue.ts` is the only file that touches storage.

import type { IntegrityStep } from "./signals";

/** Audit trail written when the ladder reaches its top rung. */
export const PROPOSAL_EVENT = "integrity-review";
/** The owner's answer to one. */
export const DECISION_EVENT = "integrity-decision";

/**
 * Cooldown kind for an owner-approved sending restriction.
 *
 * Deliberately NOT "integrity" - that key already holds the signal blob, whose
 * `until` is always now+48h and whose `reason` is JSON, so `cooldownLeft` on it
 * would report a permanent block for anyone who ever tripped a single signal.
 */
export const BLOCK_KIND = "integrity-block";

export type DecisionAction = "approve" | "reject" | "lift";

export interface IntegrityDecision {
  email: string;
  action: DecisionAction;
  /** Minutes of sending restriction an approval carries. 0 for reject/lift. */
  minutes: number;
  /** Whether the approval also restricted the ACCOUNT (login), not just sends. */
  restrictAccount: boolean;
  /** The owner's words. Shown to nobody but the owner, kept for the audit. */
  note: string;
  /** Epoch ms. */
  at: number;
  /** Owner email. */
  by: string;
}

/**
 * How long an approved restriction runs. `user_cooldowns` is a timed table, so
 * "indefinite" is a far-future date rather than a new column - which also means
 * every restriction this system can impose has an end and a "Lift now" button.
 * There is no state here that a traveller cannot come back from.
 */
export const BLOCK_PRESETS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: "24 hours", minutes: 1_440 },
  { label: "7 days", minutes: 10_080 },
  { label: "30 days", minutes: 43_200 },
  { label: "Until I lift it", minutes: 5_256_000 },
];

export const MAX_BLOCK_MINUTES = 5_256_000;

export function isBlockMinutes(n: unknown): boolean {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 && v <= MAX_BLOCK_MINUTES;
}

/** "pending" is the ONLY state that asks the owner for anything. */
export type CaseState = "pending" | "approved" | "rejected" | "lifted";

export interface ProposalCase {
  email: string;
  plan: string;
  /** Where this traveller stands on the ladder right now. */
  step: IntegrityStep;
  score: number;
  evidence: string[];
  signalCount: number;
  /** Newest live signal (epoch ms) - what a decision has to be newer than. */
  latestSignalAt: number;
  state: CaseState;
  decision: IntegrityDecision | null;
  /** Minutes left on an owner-approved sending restriction (0 if none). */
  restrictedMinutes: number;
  /** Whether the account itself is restricted (login blocked). */
  accountBlocked: boolean;
}

// ---- decision serialisation -------------------------------------------------
// `agent_events.detail` is a JSON string everywhere else in this repo; a
// decision is one more of those, so there is no migration and the audit lives
// in the same feed as everything else the agents do.

export function encodeDecision(d: Omit<IntegrityDecision, "email" | "at">): string {
  return JSON.stringify({
    action: d.action,
    minutes: Math.max(0, Math.round(d.minutes)),
    restrictAccount: d.restrictAccount === true,
    note: String(d.note ?? "").slice(0, 400),
    by: d.by,
  });
}

export function decodeDecision(row: {
  user_email?: string | null;
  detail?: string | null;
  created_at?: string | null;
}): IntegrityDecision | null {
  const email = String(row.user_email ?? "").trim().toLowerCase();
  if (!email) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(String(row.detail ?? "{}")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const action = j.action;
  if (action !== "approve" && action !== "reject" && action !== "lift") return null;
  const at = Date.parse(String(row.created_at ?? ""));
  return {
    email,
    action,
    minutes: Number.isFinite(Number(j.minutes)) ? Number(j.minutes) : 0,
    restrictAccount: j.restrictAccount === true,
    note: String(j.note ?? ""),
    at: Number.isFinite(at) ? at : 0,
    by: String(j.by ?? ""),
  };
}

// ---- the state machine ------------------------------------------------------

/** The newest live signal, or 0 when there are none. */
export function latestSignalAt(signals: Array<{ at: number }>): number {
  let newest = 0;
  for (const s of signals) if (Number.isFinite(s.at) && s.at > newest) newest = s.at;
  return newest;
}

export function latestDecisionFor(
  decisions: IntegrityDecision[],
  email: string
): IntegrityDecision | null {
  const key = email.trim().toLowerCase();
  let best: IntegrityDecision | null = null;
  for (const d of decisions) {
    if (d.email !== key) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best;
}

/**
 * A decision only settles the evidence it was made on.
 *
 * This is the whole reason there is no "re-flag" branch anywhere: if a signal
 * arrives after the owner decided, the case is pending again, because the owner
 * has not seen that signal. Nothing has to remember to re-open it.
 */
export function caseStateFor(
  newestSignalAt: number,
  decision: IntegrityDecision | null
): CaseState {
  if (!decision) return "pending";
  if (decision.at < newestSignalAt) return "pending";
  if (decision.action === "approve") return "approved";
  if (decision.action === "lift") return "lifted";
  return "rejected";
}

/**
 * What the owner is actually asked to decide: a case at the top rung with no
 * decision covering its newest evidence. Everything else is context.
 */
export function needsDecision(c: ProposalCase): boolean {
  return c.step === "propose-block" && c.state === "pending";
}

export interface QueuePartition {
  /** Waiting on the owner. */
  proposals: ProposalCase[];
  /** Already decided (newest first) - the audit, and where "Lift" lives. */
  decided: ProposalCase[];
  /** On the ladder but below the top rung. Context, never an ask. */
  watch: ProposalCase[];
}

export function partitionCases(cases: ProposalCase[]): QueuePartition {
  const byRecency = (a: ProposalCase, b: ProposalCase) => b.latestSignalAt - a.latestSignalAt;
  const proposals = cases.filter(needsDecision).sort((a, b) => b.score - a.score || byRecency(a, b));
  const decided = cases
    .filter((c) => !needsDecision(c) && c.decision !== null)
    .sort((a, b) => (b.decision?.at ?? 0) - (a.decision?.at ?? 0));
  const watch = cases
    .filter((c) => !needsDecision(c) && c.decision === null && c.score > 0)
    .sort(byRecency);
  return { proposals, decided, watch };
}
