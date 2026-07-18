// Pure bounded-retry decision for a graph wakeup (strategic-wait tick / judge
// job) whose run THREW a transient error (LLM 5xx, Supabase blip mid-turn).
//
// drainGraphWakeups claims a due wakeup by DELETING it, then runs the turn. If
// the run throws, the wakeup is gone - and nothing reschedules it, because the
// reschedule normally happens DURING a successful turn. So a transient failure
// silently stalled the negotiation forever (the agent stopped following up).
// This decides whether to re-park the wakeup and with what backoff, bounded so
// a persistently-failing turn cannot loop indefinitely.

export const WAKEUP_MAX_RETRIES = 5;

export type WakeupRetry =
  | { reschedule: false }
  | { reschedule: true; attempts: number; delayMs: number };

export function wakeupRetryDecision(priorAttempts: number): WakeupRetry {
  const attempts = priorAttempts + 1;
  if (attempts > WAKEUP_MAX_RETRIES) return { reschedule: false };
  // Backoff 5/10/15/20/25 min, capped at 30 - long enough for a flaky provider
  // to recover, short enough that a live negotiation resumes the same session.
  const delayMs = Math.min(attempts * 5, 30) * 60_000;
  return { reschedule: true, attempts, delayMs };
}
