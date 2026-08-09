// WAVE PACING - short bursts separated by real silence, which is what a person
// looks like. Plan Part 11 F1.
//
// THIS SUPERSEDES VECTOR 1's 5-8 per 8-12 MINUTES, and the difference is not a
// tuning tweak: 5-8 per 20 minutes is 2.5x slower than anything the previous
// five research rounds proposed. That is a real safety gain and it costs six
// shops off the day-one ceiling - 24 rather than 30. At a reply rate of 0.35 a
// 24-shop batch settles to roughly 15 open unanswered threads against ~19-21
// for 30, which lands meaningfully below the exposure the two-meter budget was
// sized for.
//
// This module sits ABOVE `batchStagger`, it does not replace it. `batchStagger`
// already schedules to a deadline and enforces HARD_MIN_GAP_SEC; a second
// scheduler is how one call site keeps the old behaviour by accident. Inside a
// wave, `batchStagger` runs unchanged over a window of roughly 60% of the wave
// gap - so each wave is a short burst followed by genuine silence.
//
// THE SCHEDULE IS PERSISTED, NEVER HELD IN MEMORY. Cloud Run throttles CPU to
// zero the instant the response flushes, so an in-request timer spanning an hour
// cannot exist. Offsets are written onto the outbox rows at enqueue time.
//
// AND IT HAS TO BE EXPRESSED TWICE. `not_before` sets a row's initial floor, but
// the authoritative pacer for cold intros is the DRAIN, which selects on
// `not_before <= now` and applies its own per-sender ceiling. A wave schedule
// written only at enqueue is reshaped by the drain on first contact. Building it
// in one place is the failure mode this comment exists to prevent.

import { gaussianUnit } from "./pacing";

/** Wave sizes are drawn from this range, shaped by a bell rather than flat. */
export const WAVE_MIN = 5;
export const WAVE_MAX = 8;

/** Minutes between wave STARTS. Centred on 20, drawn 18-22. */
export const WAVE_GAP_MIN_MINUTES = 18;
export const WAVE_GAP_MAX_MINUTES = 22;

/**
 * Day-one ceiling, in shops.
 *
 * Owner decision. It is deliberately equal to MASS_BARGAIN_MAX so a full run is
 * exactly three waves and the two constants cannot drift into disagreeing about
 * what a batch is.
 */
export const WAVE_DAY_ONE_CEILING = 24;

/** Fraction of the wave gap that the in-wave burst is allowed to occupy. */
export const WAVE_BURST_FRACTION = 0.6;

export interface Wave {
  index: number;
  size: number;
  /** Milliseconds from the batch start to this wave's first send. */
  startOffsetMs: number;
  /** How long this wave's own sends may spread over. */
  spanMs: number;
}

function drawInt(min: number, max: number, rand: () => number): number {
  // gaussianUnit returns a bell on [0,1]; map it onto the inclusive range.
  const u = gaussianUnit(0.5, 0.22, rand);
  return Math.min(max, Math.max(min, Math.round(min + u * (max - min))));
}

export interface PlanWavesInput {
  total: number;
  /** Hard ceiling on shops actually scheduled. Defaults to the day-one value. */
  ceiling?: number;
  rand?: () => number;
}

export interface WavePlan {
  waves: Wave[];
  /** Shops actually scheduled - may be below `total` when the ceiling bites. */
  scheduled: number;
  /** Shops the ceiling refused. Surfaced, never silently dropped. */
  overflow: number;
  /** When the last wave's burst ends, for an honest ETA. */
  completionMs: number;
}

/**
 * Split a batch into waves.
 *
 * Deterministic given `rand`, so the schedule test can assert the invariants
 * rather than sample them.
 */
export function planWaves(input: PlanWavesInput): WavePlan {
  const rand = input.rand ?? Math.random;
  const ceiling = Math.max(0, input.ceiling ?? WAVE_DAY_ONE_CEILING);
  const scheduled = Math.min(Math.max(0, Math.floor(input.total)), ceiling);
  // OVERFLOW IS RETURNED, NOT SWALLOWED. Part 5.5's finding: the mass route
  // emitted no result row for shops dropped before its loop, so those shops
  // were counted nowhere and could not be explained to the traveller.
  const overflow = Math.max(0, Math.floor(input.total) - scheduled);

  const waves: Wave[] = [];
  let remaining = scheduled;
  let cursor = 0;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, drawInt(WAVE_MIN, WAVE_MAX, rand));
    const gapMinutes = drawInt(WAVE_GAP_MIN_MINUTES, WAVE_GAP_MAX_MINUTES, rand);
    const gapMs = gapMinutes * 60_000;
    waves.push({
      index,
      size,
      startOffsetMs: cursor,
      spanMs: Math.round(gapMs * WAVE_BURST_FRACTION),
    });
    remaining -= size;
    cursor += gapMs;
    index += 1;
  }

  const last = waves[waves.length - 1];
  return {
    waves,
    scheduled,
    overflow,
    completionMs: last ? last.startOffsetMs + last.spanMs : 0,
  };
}

/**
 * Which wave does the Nth shop of a batch belong to?
 *
 * The drain needs this: it holds one row at a time and has to know whether that
 * row's wave has opened yet, without re-deriving the whole schedule.
 */
export function waveOfIndex(waves: Wave[], position: number): Wave | null {
  let seen = 0;
  for (const w of waves) {
    if (position < seen + w.size) return w;
    seen += w.size;
  }
  return null;
}

/**
 * An honest completion estimate for a batch.
 *
 * PER-TIER DURATION IS NOT ONE HOUR, and this is the number the progress bar
 * must be driven by. Free tier is 10 shops - two waves, about 20-25 minutes.
 * Only a full 24-shop batch approaches an hour. A bar hardcoded to 60 minutes
 * would sit at 40% while a free-tier batch was already finished.
 */
export function estimateBatchCompletion(plan: WavePlan): number {
  return plan.completionMs;
}

/**
 * THE DRAIN-SIDE HALF, and without it the enqueue schedule is decorative.
 *
 * The drain sends at most a couple of cold rows per invocation and re-stamps the
 * rest a few minutes out. Inside a 20-minute wave that is harmless - but a wave
 * of 8 needs several invocations to clear, and each re-stamp pushes rows later.
 * Left alone, a burst bleeds across its own silence and into the next wave,
 * which is precisely the shape waves exist to avoid: the schedule ends up a
 * continuous trickle again, just with extra steps.
 *
 * So a cold row's re-stamp is CLAMPED to its own wave's end. It may be delayed
 * within the burst, and it may overflow to the wave boundary, but it can never
 * land in the quiet gap.
 *
 * Returns the timestamp the drain should actually park the row at.
 *
 * A row with no wave metadata is returned unchanged. That is the legacy path -
 * every row enqueued before waves were switched on - and it must keep behaving
 * exactly as it does today.
 */
export function clampRestampToWave(
  proposedAt: number,
  waveEndsAt: number | null | undefined
): number {
  if (!waveEndsAt || !Number.isFinite(waveEndsAt)) return proposedAt;
  return Math.min(proposedAt, waveEndsAt);
}

/**
 * When does the wave containing this position end, in absolute time?
 *
 * Stamped onto the outbox row at enqueue so the drain does not have to re-derive
 * a schedule it never saw. Re-deriving would need the same seed, and a schedule
 * that depends on a seed surviving a redeploy is a schedule that silently
 * changes shape on every deploy.
 */
export function waveEndsAtFor(
  batchStartMs: number,
  waves: Wave[],
  position: number
): number | null {
  const w = waveOfIndex(waves, position);
  if (!w) return null;
  return batchStartMs + w.startOffsetMs + w.spanMs;
}

/**
 * The honest promise, in one sentence.
 *
 * If dispatch ends at t+60 the last shop cannot reply AND negotiate inside the
 * hour, so "the best local price within the hour" was never keepable at a safe
 * send rate. Wave 1's replies land around t+5-8, which is what makes the first
 * half of this sentence true.
 */
export const WAVE_SLA_PROMISE = "Your first real quotes within the hour.";
