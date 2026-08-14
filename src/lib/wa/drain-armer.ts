// THE NEXT RUNTIME'S OWN DRAIN ARMER.
//
// `setDrainArmer` (wa/park.ts) was dependency-inverted so the worker runtime
// could schedule an exact-moment drain - and the worker runtime is deployed
// nowhere (`services/workers` is in no Dockerfile CMD), so the hook has been
// dark in production since it shipped. The Next runtime's fallbacks are the
// reply-tick dispatcher (great, but only alive while a kick chain is running)
// and the 1-minute cron. A reply re-parked 20-40s out by a lost pacing claim
// therefore landed on the NEXT CRON MINUTE, not 20-40s later - the floor was
// paid and the ceiling still charged on top.
//
// This is the in-process armer for the Next runtime. It is deliberately NOT a
// dangling drain: on Cloud Run the container's CPU drops to ~0 once the
// response is flushed, so a timer that tried to drain in-process would freeze
// mid-write. The timer's only job is to fire an HTTP self-kick (wa/kick.ts) -
// the kicked dispatcher runs in its OWN invocation with its own CPU. If the
// timer itself is frozen by throttling it fires late when CPU returns, and the
// cron remains the backstop either way; the armer is a fast path by contract,
// never a correctness dependency.

import { kickDispatcher } from "./kick";

/** Beyond this horizon the 1-minute cron is on time anyway - arming would only
 *  add timers that outlive their usefulness. */
export const ARM_HORIZON_MS = 90_000;

/** One armed timer per sender: the earliest due row wins, a later arm for the
 *  same sender is already covered by the earlier kick (the dispatcher drains
 *  everything due and then WAITS on what is not). */
const armed = new Map<string, { atMs: number; timer: ReturnType<typeof setTimeout> }>();

async function fireKick(senderKey: string): Promise<void> {
  try {
    const { webhookToken } = await import("../evolution");
    const { resolveSiteOrigin } = await import("../site");
    const token = await webhookToken();
    if (!token) return;
    const origin = await resolveSiteOrigin();
    // The PER-SENDER reply dispatcher, not the global chain: a hop=0 kick at
    // /api/wa/tick loses to a live cold-batch chain one hundred percent of the
    // time (the exact starvation reply-tick was built to end).
    await kickDispatcher(
      `${origin}/api/wa/reply-tick?token=${encodeURIComponent(token)}` +
        `&sender=${encodeURIComponent(senderKey)}&hop=0`
    );
  } catch {
    /* best-effort by contract - the cron drains it a minute later */
  }
}

/**
 * Arm an exact-moment drain for `senderKey`'s row due at `atMs`.
 * No-op when the row is beyond the horizon (the cron covers it) or when an
 * earlier-or-equal arm for the same sender already exists.
 */
export function armReplyDrain(atMs: number, senderKey?: string | null): void {
  if (!senderKey) return;
  const delay = atMs - Date.now();
  if (delay > ARM_HORIZON_MS) return;
  const prior = armed.get(senderKey);
  if (prior && prior.atMs <= atMs) return; // an earlier kick already covers this row
  if (prior) clearTimeout(prior.timer);
  const timer = setTimeout(
    () => {
      armed.delete(senderKey);
      void fireKick(senderKey);
    },
    // +400ms so the row is due, not almost-due, when the dispatcher reads it.
    Math.max(0, delay) + 400
  );
  // Never keep the process alive for an arm (tests, local dev, shutdown).
  timer.unref?.();
  armed.set(senderKey, { atMs, timer });
}
