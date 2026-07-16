// Pure negotiation math - no IO, no server-only, so tests and the client-side
// Studio preview can import it freely.

export function niceRound(x: number): number {
  if (x >= 1000) return Math.round(x / 50) * 50;
  if (x >= 200) return Math.round(x / 10) * 10;
  if (x >= 50) return Math.round(x / 5) * 5;
  return Math.round(x);
}

/**
 * The target price for the current bargain round - the owner's launch
 * playbook, made GAP-AWARE so the ladder keeps chasing the floor whenever
 * realistic room remains (it used to dead-end when the shop's concession
 * landed just under the fixed round-1 formula):
 *   round 0: ask the REAL market floor itself ("300 is really expensive for
 *            me... can you give me 160 a day my friend?") - the days are the
 *            leverage, the floor is the anchor. No floor known: 60% of quote.
 *   round 1: concede the SMALLER of 15% above the floor or a quarter of the
 *            remaining gap - so a shop already close to the floor gets a
 *            proportionate micro-ask instead of no ask at all.
 *   round 2: push to halfway between the current quote and the floor (never
 *            above a 5% trim), always a clean round number.
 *   round 3+: a tiny final nudge (usually fails the real-saving test -> close)
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
  const gap = floorPrice ? Math.max(0, quoted - floorPrice) : 0;
  let base: number;
  if (rounds <= 0) {
    base = floorPrice ?? Math.round(quoted * 0.6);
  } else if (rounds === 1) {
    base = floorPrice
      ? Math.round(floorPrice + Math.min(0.15 * floorPrice, 0.25 * gap))
      : lastTarget && lastTarget < quoted
      ? Math.round((quoted + lastTarget) / 2)
      : Math.round(quoted * 0.9);
  } else if (rounds === 2 && floorPrice && gap > 0) {
    base = Math.round(Math.min(quoted * 0.95, floorPrice + 0.5 * gap));
  } else {
    base = Math.round(quoted * 0.95);
  }
  if (floorPrice) base = Math.max(base, floorPrice);
  // Never re-ask BELOW an earlier ask (the ladder concedes upward, it does not
  // zigzag), and a cheaper real rival caps the ask.
  if (lastTarget && rounds > 0 && base < lastTarget) base = lastTarget;
  const target = rivalPrice && rivalPrice < base ? Math.max(floorPrice ?? 0, rivalPrice) : base;
  const nice = niceRound(target);
  return nice >= quoted ? undefined : nice;
}
