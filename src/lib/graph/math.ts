// Pure negotiation math - no IO, no server-only, so tests and the client-side
// Studio preview can import it freely.

export function niceRound(x: number): number {
  if (x >= 1000) return Math.round(x / 50) * 50;
  if (x >= 200) return Math.round(x / 10) * 10;
  if (x >= 50) return Math.round(x / 5) * 5;
  return Math.round(x);
}

/**
 * The target price for the current bargain round - a concession ladder that
 * asks less aggressively each round and never above the shop's quote:
 *   round 0: anchor toward the floor (>= 60% of quote)
 *   round 1: meet between their new quote and our last ask (a soft step)
 *   round 2+: a tiny final nudge (usually fails the real-saving test -> close)
 * A cheaper REAL rival offer caps the ask (honest leverage, never invented).
 * Returns undefined when no ask below the quote is possible.
 */
export function computeRoundTarget(args: {
  quoted: number;
  floorPrice?: number;
  rivalPrice?: number;
  rounds: number;
  lastTarget?: number;
}): number | undefined {
  const { quoted, floorPrice, rivalPrice, rounds, lastTarget } = args;
  let base: number;
  if (rounds <= 0) {
    base = floorPrice
      ? Math.max(floorPrice, Math.round(quoted * 0.6))
      : Math.round(quoted * 0.85);
  } else if (rounds === 1) {
    base =
      lastTarget && lastTarget < quoted
        ? Math.round((quoted + lastTarget) / 2)
        : Math.round(quoted * 0.9);
  } else {
    base = Math.round(quoted * 0.95);
  }
  if (floorPrice) base = Math.max(base, floorPrice);
  const target = rivalPrice && rivalPrice < base ? Math.max(floorPrice ?? 0, rivalPrice) : base;
  const nice = niceRound(target);
  return nice >= quoted ? undefined : nice;
}
