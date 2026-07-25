// Pure, unit-testable aggregations for the Engine section overhaul (Module 3).
// The engine-inspector route reads recent engine-v3-turn rows and calls these to
// build the hand-rolled charts (turns/hour bars, move mix, provider mix) and the
// latency percentiles. No env, no I/O - deterministic given (rows, nowMs) so the
// tiers render the same numbers the tests assert.

export interface StatTurn {
  at?: string;
  move?: string;
  provider?: string | null;
  latencyMs?: number | null;
}

/** Nearest-rank p-th percentile of a numeric array (mirrors kpis.percentile). */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))];
}

/**
 * Turns bucketed into the last `hours` one-hour windows, OLDEST first so a bar
 * chart reads left (older) -> right (now). Index `hours-1` is the current hour.
 * Rows outside the window or with an unparseable timestamp are ignored.
 */
export function bucketTurnsPerHour(turns: StatTurn[], nowMs: number, hours = 6): number[] {
  const buckets = new Array(hours).fill(0) as number[];
  for (const t of turns) {
    if (!t.at) continue;
    const ms = Date.parse(t.at);
    if (!Number.isFinite(ms)) continue;
    const ageH = Math.floor((nowMs - ms) / 3_600_000);
    if (ageH < 0 || ageH >= hours) continue;
    // ageH 0 = current hour -> last bucket; ageH hours-1 = oldest -> first.
    buckets[hours - 1 - ageH] += 1;
  }
  return buckets;
}

/** Counts per move, descending, so the biggest slice leads the mix chart. */
export function moveMix(turns: StatTurn[]): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of turns) {
    const k = t.move || "unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** Counts per model provider (null/absent -> "mock/local"), descending. */
export function providerMix(turns: StatTurn[]): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of turns) {
    const k = t.provider || "mock/local";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** p50/p95 response latency (ms) over turns that carry a real latency sample. */
export function latencyStats(turns: StatTurn[]): { p50: number | null; p95: number | null; samples: number } {
  const xs: number[] = [];
  for (const t of turns) {
    if (typeof t.latencyMs === "number" && t.latencyMs >= 0) xs.push(t.latencyMs);
  }
  return { p50: percentile(xs, 50), p95: percentile(xs, 95), samples: xs.length };
}
