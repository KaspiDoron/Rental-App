// A per-process, per-key time throttle for best-effort diagnostic traces.
//
// The formerly-silent inbound-drop and webhook-403 paths must leave SOME trail
// (or the next incident is screenshot archaeology again), but they run on hot,
// sometimes UNAUTHENTICATED paths - so an unthrottled `sbInsert` per event would
// be a self-inflicted DB DoS. This gates a trace to at most one write per
// `windowMs` per key, backed by a size-bounded Map so a flood of distinct keys
// (e.g. many instances) can never grow memory without bound.
//
// It is an in-memory throttle: on a horizontally-scaled deploy each process
// keeps its own window, so the effective rate is (processes / windowMs). That is
// the intended, safe behavior - a few rows per window is plenty of signal.

import { boundedSet } from "../bounded-map";

const MAX_KEYS = 2000;

export interface TraceThrottle {
  /** True (and records the timestamp) when a trace for `key` is allowed now. */
  allow(key: string, nowMs?: number): boolean;
  /**
   * How many events this key SWALLOWED since the last allowed one - and reset.
   *
   * The throttle protects the DB, but it was also quietly destroying the
   * magnitude: a burst of twenty drops wrote one row, and the panel then said
   * "1 drop" for an incident that lost twenty messages. The rate limit is
   * right; losing the count was not. Callers stamp this on the row they are
   * about to write, so one row can honestly say it stands for twenty.
   */
  takeSuppressed(key: string): number;
}

export function makeTraceThrottle(windowMs: number): TraceThrottle {
  const last = new Map<string, number>();
  const suppressed = new Map<string, number>();
  return {
    allow(key: string, nowMs = Date.now()): boolean {
      const prev = last.get(key);
      if (prev !== undefined && nowMs - prev < windowMs) {
        boundedSet(suppressed, key, (suppressed.get(key) ?? 0) + 1, MAX_KEYS);
        return false;
      }
      boundedSet(last, key, nowMs, MAX_KEYS);
      return true;
    },
    takeSuppressed(key: string): number {
      const n = suppressed.get(key) ?? 0;
      suppressed.delete(key);
      return n;
    },
  };
}
