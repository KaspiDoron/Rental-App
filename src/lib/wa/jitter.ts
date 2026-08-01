// POISSON INTER-ARRIVAL JITTER.
//
// Every pre-send pause in this codebase was uniform - `900 + random()*500`,
// `600 + random()*1400`. Uniform noise is still a signature: draw enough
// samples and the gaps form a flat-topped block with hard edges at both ends,
// which is not what a person messaging on their phone produces and is trivially
// separable from one. Human message arrivals are close to a POISSON process, so
// the gap between them is exponentially distributed: mostly short, with a long
// tail. That shape is the point - not the randomness, which we already had.
//
// The draw is `floor + Exp(mean)`, clamped. The shift matters: a raw
// exponential clamped at 800ms would pile ~half of all draws onto the floor,
// re-creating a fixed constant at exactly the value we were trying to avoid.
// Shifting instead leaves the mass spread across the band, with only ~4% of
// draws touching the ceiling.

/** Lower bound: below this a "human" reply is suspiciously instant. */
export const JITTER_MIN_MS = 800;
/** Upper bound: the owner's addendum, and a real latency budget on the send path. */
export const JITTER_MAX_MS = 2400;
/** Mean of the exponential component; total mean lands near 1.28s. */
const TAIL_MEAN_MS = 500;

/**
 * One Poisson inter-arrival gap in [JITTER_MIN_MS, JITTER_MAX_MS].
 *
 * `rand` is injectable so the distribution can be pinned in tests without
 * making the production path deterministic - a fixed gap is the fingerprint.
 */
export function poissonDelayMs(rand: () => number = Math.random): number {
  // Inverse-transform sampling: -ln(1-u)/lambda. Guard u away from 1 so a
  // pathological rand() returning exactly 1 cannot produce Infinity.
  const u = Math.min(Math.max(rand(), 0), 0.999_999);
  const tail = -Math.log(1 - u) * TAIL_MEAN_MS;
  const draw = JITTER_MIN_MS + tail;
  return Math.round(Math.min(JITTER_MAX_MS, draw));
}

/** Sleep for one Poisson gap. Background send paths only - never UI-blocking. */
export async function poissonPause(rand: () => number = Math.random): Promise<void> {
  const ms = poissonDelayMs(rand);
  await new Promise((r) => setTimeout(r, ms));
}
