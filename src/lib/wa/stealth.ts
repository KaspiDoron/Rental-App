// Predictive "stealth mode" - the graduated danger-zone slowdown.
//
// The old model ran at full throughput until the ban-risk score crossed a hard
// threshold, then slammed the number into a long pause. That is both too late
// (the damage - blocks, failed sends, a dead reply rate - already happened) and
// too blunt (a full freeze kills throughput). Stealth mode reacts EARLY and
// PROPORTIONALLY: as the risk score climbs through the band below the hard
// pause, sends are paced progressively slower and bursts tightened, so a number
// that starts to wobble becomes calmer and less clusterable on its own - and
// recovers to full speed the moment the signals do. Pure + isomorphic so the
// guard and the tests share one definition.

/**
 * Multiplier applied to the min-gap (and inverse to burst tolerance) from the
 * current ban-risk score. 1x while calm (risk at/under 40% of the pause
 * threshold), ramping linearly to 3x as risk approaches the hard pause. Never
 * a freeze - the pipeline keeps moving, just slower and safer.
 */
export function stealthFactor(risk: number, pauseThreshold: number): number {
  const lo = Math.max(1, pauseThreshold * 0.4);
  if (risk <= lo) return 1;
  const span = Math.max(1, pauseThreshold - lo);
  const t = Math.min(1, (risk - lo) / span);
  return 1 + t * 2; // 1x (calm) .. 3x (right below the hard pause)
}
