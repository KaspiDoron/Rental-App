// Honest progress for paced sends - pure + isomorphic so the status strip,
// the queued card and any API can derive the SAME numbers.
//
// Truthfulness rules (each covers a real edge case):
//  - counts come from LIVE rows, never a frozen batch size: removing a
//    queued message mid-batch shrinks the plan honestly ("2 of 5 remaining"
//    never lies about rows that no longer exist)
//  - the ETA is max(notBefore) of what actually remains - holds injected by
//    caps/hours push it out honestly (never index math)
//  - overlapping batches simply merge: the user cares about "what is still
//    waiting and when is it done", not batch bookkeeping
//  - nothing waiting -> null (the line disappears; no zombie "0 left")

export interface PendingSendRow {
  notBefore: string; // ISO
}

export interface SendProgress {
  sent: number;
  waiting: number;
  total: number;
  /** ISO of the next departure (undefined when something is due right now). */
  nextAt?: string;
  /** ISO when the last waiting message should have left. */
  doneBy?: string;
  /** True when at least one row is due now (sending on the next drain). */
  dueNow: boolean;
}

export function sendProgress(
  pending: PendingSendRow[],
  sentCount: number,
  nowMs: number
): SendProgress | null {
  const waiting = pending.filter((p) => Number.isFinite(Date.parse(p.notBefore)));
  if (waiting.length === 0) return null;
  const times = waiting.map((p) => Date.parse(p.notBefore)).sort((a, b) => a - b);
  const future = times.filter((t) => t > nowMs);
  return {
    sent: Math.max(0, sentCount),
    waiting: waiting.length,
    total: Math.max(0, sentCount) + waiting.length,
    nextAt: future.length && future[0] === times[0] ? new Date(times[0]).toISOString() : undefined,
    doneBy: new Date(times[times.length - 1]).toISOString(),
    dueNow: times[0] <= nowMs,
  };
}
