// ONE DRAIN OWNER PER USER PER CYCLE (owner report 6, E2/L2).
//
// Three polls (/api/replies every ~8s, /api/activity, /api/wa/status) each ran
// the outbox + wakeup drains inline, bounded at 8s apiece - so the SAME
// user's queue was drained twice or three times per cycle, and the most
// frequent request the app makes could sit behind 16s of somebody's slow
// Evolution host before answering with its actual payload. The drains are
// idempotent (claims serialize the sends), so the extra runs bought nothing
// but latency.
//
// This is a per-instance memory throttle, deliberately: the drain's own row
// claims are the cross-instance correctness layer, this stamp only stops
// REDUNDANT work. Worst case with N instances a user's polls drain N times
// per interval - still bounded, still correct. The webhook tail and the
// 1-minute heartbeat drain independently, so a skipped poll never strands a
// due message beyond this interval.

const lastDrainAt = new Map<string, number>();

/** How long one poll's drain claim covers its siblings. Under the 8s poll
 *  cadence this means roughly every third poll pays the drain, the rest
 *  answer at payload speed. */
export const DRAIN_OWNER_INTERVAL_MS = 20_000;

/**
 * Claim the drain slot for this user. True = you drain this cycle; false =
 * a sibling ran (or is running) recently - skip, your poll answers fast.
 */
export function claimDrainSlot(
  email: string,
  intervalMs: number = DRAIN_OWNER_INTERVAL_MS,
  now: number = Date.now()
): boolean {
  const prev = lastDrainAt.get(email);
  if (prev !== undefined && now - prev < intervalMs) return false;
  lastDrainAt.set(email, now);
  // The map only ever grows by active users on this instance; prune entries
  // that can never claim-block again so a long-lived instance stays flat.
  if (lastDrainAt.size > 2_000) {
    for (const [k, at] of lastDrainAt) {
      if (now - at > intervalMs) lastDrainAt.delete(k);
    }
  }
  return true;
}

/** Test hook: forget every stamp. */
export function resetDrainSlots(): void {
  lastDrainAt.clear();
}
