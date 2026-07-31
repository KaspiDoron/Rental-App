// Turn-latency percentiles - pure, so the doctor's speed panel is testable.
//
// The engine stamps one `turn-latency` agent_event per composed turn (see
// stampTurnLatency in agent-loop). "Replies land in ~1-2 min" used to be a
// claim with nothing behind it: the deliberate pacing delay showed up in the
// trace, but the LLM chain that ran BEFORE that delay - the part that actually
// pushed a reply past the ceiling - was never recorded anywhere. These are the
// numbers that make the promise checkable.

export interface TurnLatencyStats {
  samples: number;
  /** Chain time only (extraction + engine + validator + localization), ms. */
  composeP50: number | null;
  composeP95: number | null;
  /** Chain time PLUS the deliberate human pacing delay, seconds. */
  totalP50Sec: number | null;
  totalP95Sec: number | null;
  parked: number;
  sent: number;
  failed: number;
}

const EMPTY: TurnLatencyStats = {
  samples: 0,
  composeP50: null,
  composeP95: null,
  totalP50Sec: null,
  totalP95Sec: null,
  parked: 0,
  sent: 0,
  failed: 0,
};

/**
 * Nearest-rank percentile on an ASCENDING array. Nearest-rank (not linear
 * interpolation) because these are latency samples read off a handful of real
 * turns: an interpolated "p95" between two observations is a number that never
 * happened, and this panel exists to report what did.
 */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

export function turnLatencyStats(details: Array<string | null | undefined>): TurnLatencyStats {
  const compose: number[] = [];
  const total: number[] = [];
  let parked = 0;
  let sent = 0;
  let failed = 0;
  for (const d of details) {
    if (!d) continue;
    let row: { composeMs?: unknown; plannedDelayS?: unknown; outcome?: unknown };
    try {
      row = JSON.parse(d);
    } catch {
      continue; // a malformed row is dropped, never counted as a fast turn
    }
    const ms = Number(row.composeMs);
    if (!Number.isFinite(ms) || ms < 0) continue;
    const delayS = Number(row.plannedDelayS);
    compose.push(ms);
    total.push(ms / 1000 + (Number.isFinite(delayS) && delayS > 0 ? delayS : 0));
    if (row.outcome === "parked") parked += 1;
    else if (row.outcome === "sent") sent += 1;
    else if (row.outcome === "send-failed") failed += 1;
  }
  if (!compose.length) return { ...EMPTY };
  compose.sort((a, b) => a - b);
  total.sort((a, b) => a - b);
  const round = (n: number | null) => (n === null ? null : Math.round(n));
  return {
    samples: compose.length,
    composeP50: round(percentile(compose, 50)),
    composeP95: round(percentile(compose, 95)),
    totalP50Sec: round(percentile(total, 50)),
    totalP95Sec: round(percentile(total, 95)),
    parked,
    sent,
    failed,
  };
}
