// Resuming must actually resume.
//
// The live failure: five cold introductions sat in the queue with "next at
// ~23:47 - all done by ~00:02" while the panel above them said "Agents active".
// Every one of those rows had been parked by the session-pause branch of the
// guard (wa-guard rule 0.1), which stamps `not_before` an hour out. Turning the
// agents back on wrote a `session-resumed` marker and nothing else - the rows
// kept their hour-long hold, so a resume bought the traveller a wait, not a
// send. The queue was telling the truth ("Paused by you"); the switch above it
// was the stale one.
//
// So: a resume RELEASES the rows the pause parked. Only those - a row held for
// business hours, an hourly cap or a burst cooldown keeps its hold, because
// those reasons did not go away. Released rows are re-stamped on a min-gap
// ladder rather than all at `now`, so the batch leaves paced (the drain's own
// claim slots are still the real velocity ceiling) and the ETA the UI shows is
// honest the moment it repaints.

import { classifyQueueReason } from "../queue-reason";

/** The reason a released row carries: honest, and classified as pacing. */
export const RESUMED_REASON = "resumed - human pacing gap";

/**
 * When the Nth released row may leave. A small lead-in so the first one is
 * effectively immediate, then one min-gap per row - ten rows at the default
 * 12s gap clear inside ~2 minutes. Pure, so the ladder is unit-tested.
 */
export function releasedNotBefore(index: number, nowMs: number, gapSeconds: number): string {
  const step = Math.max(1, gapSeconds) * 1000;
  return new Date(nowMs + 5_000 + Math.max(0, index) * step).toISOString();
}

/** Was this row parked BY the session pause (and only by it)? */
export function parkedByPause(reason?: string | null): boolean {
  return classifyQueueReason(reason) === "paused";
}

interface OutboxPeek {
  id: number;
  not_before: string;
  meta: { reason?: string } | null;
}

/**
 * Pull every pause-parked row for this sender forward. Returns how many were
 * released. Best-effort by design: the drain re-checks the guard on every row
 * anyway, so a failure here costs a slower resume, never a wrong send.
 */
export async function releasePausedQueue(senderKey: string): Promise<number> {
  const { sbSelect, sbUpdate } = await import("../runtime-config");
  const { getPolicies } = await import("../wa-guard");
  const rows = await sbSelect<OutboxPeek>(
    "wa_outbox",
    `select=id,not_before,meta&sender_key=eq.${encodeURIComponent(
      senderKey
    )}&order=not_before.asc&limit=200`
  ).catch(() => [] as OutboxPeek[]);

  const held = rows.filter((r) => parkedByPause(r.meta?.reason));
  if (held.length === 0) return 0;

  const gap = await getPolicies()
    .then((p) => p.min_gap_seconds)
    .catch(() => 12);
  const now = Date.now();
  let released = 0;
  for (let i = 0; i < held.length; i += 1) {
    const row = held[i];
    const ok = await sbUpdate("wa_outbox", `id=eq.${row.id}`, {
      not_before: releasedNotBefore(i, now, gap),
      meta: { ...(row.meta ?? {}), reason: RESUMED_REASON },
    }).catch(() => false);
    if (ok !== false) released += 1;
  }
  return released;
}
