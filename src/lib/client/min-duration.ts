"use client";

// A LOADING STATE THAT APPEARS MUST BE READABLE (W-12).
//
// There is no minimum-duration logic anywhere in this app, so every fast
// response produced a flash: a spinner drawn for 80ms and torn down. That is
// worse than no spinner - the eye catches the change without resolving what it
// was, and the screen reads as janky rather than fast.
//
// Two rules, and the second is the one people forget:
//
//   1. HOLD. Once a loading state is shown, keep it for at least MIN_MS so it
//      can actually be read.
//   2. DELAY. Do not show it at all for work that finishes inside GRACE_MS.
//      Without this, rule 1 makes things WORSE: a 60ms fetch would be forced
//      to display a 400ms spinner, turning instant into visibly slow.
//
// Together: instant work stays instant, slow work gets a stable indicator, and
// nothing ever flickers.

import { useEffect, useRef, useState } from "react";

/** Below this, the work is effectively instant and no indicator is shown. */
export const LOADING_GRACE_MS = 120;
/** Once shown, an indicator stays at least this long. */
export const LOADING_MIN_MS = 420;

/**
 * Pure decision, so the timing rules are testable without a DOM.
 *
 * Given when the work started, when it ended (or null if still running), and
 * "now", should the indicator be on screen?
 */
export function shouldShowLoading(args: {
  startedAt: number | null;
  endedAt: number | null;
  nowMs: number;
  graceMs?: number;
  minMs?: number;
}): boolean {
  const grace = args.graceMs ?? LOADING_GRACE_MS;
  const min = args.minMs ?? LOADING_MIN_MS;
  if (args.startedAt == null) return false;
  const elapsed = args.nowMs - args.startedAt;
  // Still running: show once past the grace period.
  if (args.endedAt == null) return elapsed >= grace;
  // Finished inside the grace period - it was never shown, so nothing to hold.
  const ranFor = args.endedAt - args.startedAt;
  if (ranFor < grace) return false;
  // It was shown. Hold it for the minimum, measured from when it APPEARED.
  const shownAt = args.startedAt + grace;
  return args.nowMs - shownAt < min;
}

/**
 * `busy` in, de-flickered `busy` out. Drop-in for any existing boolean.
 *
 * Deliberately a hook over a wrapper component: the call sites are `{busy && ...}`
 * expressions scattered through big trees, and rewriting them into wrappers
 * would be a far larger change than the problem justifies.
 */
export function useSteadyLoading(
  busy: boolean,
  opts?: { graceMs?: number; minMs?: number }
): boolean {
  const grace = opts?.graceMs ?? LOADING_GRACE_MS;
  const min = opts?.minMs ?? LOADING_MIN_MS;
  const startedAt = useRef<number | null>(null);
  const [, tick] = useState(0);

  if (busy && startedAt.current == null) startedAt.current = Date.now();
  if (!busy && startedAt.current != null) {
    const ranFor = Date.now() - startedAt.current;
    // Never shown, so release immediately.
    if (ranFor < grace) startedAt.current = null;
  }

  const endedAt = busy ? null : startedAt.current == null ? null : Date.now();
  const show = shouldShowLoading({
    startedAt: startedAt.current,
    endedAt,
    nowMs: Date.now(),
    graceMs: grace,
    minMs: min,
  });

  useEffect(() => {
    if (busy) {
      // Wake up when the grace period ends so the indicator can appear even if
      // nothing else re-renders.
      const id = setTimeout(() => tick((n) => n + 1), grace + 1);
      return () => clearTimeout(id);
    }
    if (startedAt.current == null) return;
    const shownAt = startedAt.current + grace;
    const remaining = shownAt + min - Date.now();
    if (remaining <= 0) {
      startedAt.current = null;
      tick((n) => n + 1);
      return;
    }
    const id = setTimeout(() => {
      startedAt.current = null;
      tick((n) => n + 1);
    }, remaining);
    return () => clearTimeout(id);
  }, [busy, grace, min]);

  return show;
}
