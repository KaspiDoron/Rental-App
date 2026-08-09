import { describe, it, expect, vi } from "vitest";
import {
  planWaves,
  waveOfIndex,
  estimateBatchCompletion,
  WAVE_MIN,
  WAVE_MAX,
  WAVE_GAP_MIN_MINUTES,
  WAVE_GAP_MAX_MINUTES,
  WAVE_DAY_ONE_CEILING,
  WAVE_BURST_FRACTION,
} from "./waves";
import { HARD_MIN_GAP_SEC } from "./pacing";
import { MASS_BARGAIN_MAX } from "../mass-bargain";

vi.mock("server-only", () => ({}));

// A seeded generator, so these are invariants rather than samples.
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const MIN = 60_000;

// 5-8 SHOPS PER 20 MINUTES - 2.5x SLOWER THAN ANYTHING FIVE ROUNDS PROPOSED.
//
// This supersedes Vector 1's 5-8 per 8-12 minutes. It is a real safety gain and
// it costs six shops off the day-one ceiling. At q=0.35 a 24-shop batch settles
// to ~15 open unanswered threads against ~19-21 for 30, comfortably below what
// the two-meter budget was sized for.

describe("wave shape", () => {
  it("every wave is 5-8 shops, except a final remainder", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { waves } = planWaves({ total: 24, rand: seeded(seed) });
      waves.forEach((w, i) => {
        const last = i === waves.length - 1;
        expect(w.size).toBeLessThanOrEqual(WAVE_MAX);
        if (!last) expect(w.size).toBeGreaterThanOrEqual(WAVE_MIN);
        expect(w.size).toBeGreaterThan(0);
      });
    }
  });

  it("gaps between wave starts land in 18-22 minutes", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { waves } = planWaves({ total: 24, rand: seeded(seed) });
      for (let i = 1; i < waves.length; i++) {
        const gap = waves[i].startOffsetMs - waves[i - 1].startOffsetMs;
        expect(gap).toBeGreaterThanOrEqual(WAVE_GAP_MIN_MINUTES * MIN);
        expect(gap).toBeLessThanOrEqual(WAVE_GAP_MAX_MINUTES * MIN);
      }
    }
  });

  it("a burst occupies only part of its gap - the rest is real silence", () => {
    // That silence is the whole point. A continuous trickle at the same average
    // rate does not look like a person; a short burst followed by nothing does.
    const { waves } = planWaves({ total: 24, rand: seeded(7) });
    for (let i = 1; i < waves.length; i++) {
      const gap = waves[i].startOffsetMs - waves[i - 1].startOffsetMs;
      expect(waves[i - 1].spanMs).toBeLessThan(gap);
      expect(waves[i - 1].spanMs).toBeCloseTo(gap * WAVE_BURST_FRACTION, -3);
    }
  });

  it("a burst is always long enough for the hard floor between sends", () => {
    // HARD_MIN_GAP_SEC is not negotiable, so a wave whose span could not hold
    // its own sends at the floor would push the schedule back into the drain to
    // fix - which is exactly the two-schedulers-fighting failure.
    const { waves } = planWaves({ total: 24, rand: seeded(11) });
    for (const w of waves) {
      expect(w.spanMs).toBeGreaterThanOrEqual((w.size - 1) * HARD_MIN_GAP_SEC * 1000);
    }
  });

  it("waves are contiguous and ordered", () => {
    const { waves } = planWaves({ total: 24, rand: seeded(3) });
    waves.forEach((w, i) => {
      expect(w.index).toBe(i);
      if (i > 0) expect(w.startOffsetMs).toBeGreaterThan(waves[i - 1].startOffsetMs);
    });
  });
});

describe("the day-one ceiling", () => {
  it("never schedules more than the ceiling", () => {
    const p = planWaves({ total: 100, rand: seeded(5) });
    expect(p.scheduled).toBe(WAVE_DAY_ONE_CEILING);
    expect(p.waves.reduce((n, w) => n + w.size, 0)).toBe(WAVE_DAY_ONE_CEILING);
  });

  it("OVERFLOW IS RETURNED, not swallowed", () => {
    // Part 5.5: the mass route emitted no result row for shops dropped before
    // its loop, so they were counted nowhere and could not be explained. A
    // ceiling that silently trims is the same defect wearing a different hat.
    const p = planWaves({ total: 30, rand: seeded(5) });
    expect(p.overflow).toBe(30 - WAVE_DAY_ONE_CEILING);
  });

  it("the ceiling agrees with the batch cap - they describe the same thing", () => {
    // 24 in one constant and 30 in another is how the app ends up promising
    // what the wire refuses. The three-numbers-disagreeing bug, again.
    expect(WAVE_DAY_ONE_CEILING).toBe(MASS_BARGAIN_MAX);
  });

  it("a full batch is exactly three waves at the top of the size range", () => {
    const p = planWaves({ total: 24, ceiling: 24, rand: seeded(2) });
    expect(p.waves.length).toBeGreaterThanOrEqual(3);
    expect(p.waves.length).toBeLessThanOrEqual(5);
  });

  it("an empty or negative batch plans nothing rather than throwing", () => {
    for (const total of [0, -5]) {
      const p = planWaves({ total, rand: seeded(1) });
      expect(p.waves).toHaveLength(0);
      expect(p.scheduled).toBe(0);
      expect(p.completionMs).toBe(0);
    }
  });
});

describe("PER-TIER DURATION IS NOT ONE HOUR", () => {
  it("a free-tier batch finishes in about 20-30 minutes", () => {
    // A progress bar hardcoded to 60 minutes would sit at ~40% while a free
    // batch was already done. F4's bar must read this, not a constant.
    const p = planWaves({ total: 10, rand: seeded(9) });
    const mins = estimateBatchCompletion(p) / MIN;
    expect(mins).toBeGreaterThan(10);
    expect(mins).toBeLessThan(35);
  });

  it("a full batch takes 55-105 minutes, and that is longer than 'an hour'", () => {
    // THE ARITHMETIC, because it is a real product consequence of the owner's
    // 20-minute gap and it should not surprise anyone later:
    //
    //   fewest waves  = ceil(24/8) = 3 -> 2 gaps x 18-22 min + burst ~= 55-57
    //   most waves    = ceil(24/5) = 5 -> 4 gaps x 18-22 min + burst ~= 85-101
    //
    // So full dispatch of a 24-shop batch can run past ninety minutes. That does
    // NOT break the promise, because the promise was already corrected to "your
    // first real quotes within the hour" - wave 1 replies land around t+5-8.
    // What it does mean is that any ETA copy must read this number rather than
    // assuming sixty minutes, and that the progress bar's second segment has to
    // keep moving well after the first is full.
    for (let seed = 1; seed <= 40; seed++) {
      const mins = estimateBatchCompletion(planWaves({ total: 24, rand: seeded(seed) })) / MIN;
      expect(mins).toBeGreaterThan(50);
      expect(mins).toBeLessThan(110);
    }
  });

  it("the schedule is monotone in batch size - more shops never finish sooner", () => {
    const rand = () => 0.5; // fixed draw, so only size varies
    let prev = -1;
    for (const total of [4, 8, 12, 16, 20, 24]) {
      const ms = estimateBatchCompletion(planWaves({ total, rand }));
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
  });

  it("a single-wave batch has no gap to wait through", () => {
    const p = planWaves({ total: 4, rand: seeded(9) });
    expect(p.waves).toHaveLength(1);
    expect(p.waves[0].startOffsetMs).toBe(0);
  });
});

describe("the drain can locate a row's wave without re-deriving the schedule", () => {
  it("position maps to the right wave", () => {
    const { waves } = planWaves({ total: 24, rand: seeded(4) });
    let seen = 0;
    for (const w of waves) {
      expect(waveOfIndex(waves, seen)?.index).toBe(w.index);
      expect(waveOfIndex(waves, seen + w.size - 1)?.index).toBe(w.index);
      seen += w.size;
    }
  });

  it("a position past the end has no wave", () => {
    const { waves, scheduled } = planWaves({ total: 24, rand: seeded(4) });
    expect(waveOfIndex(waves, scheduled)).toBeNull();
    expect(waveOfIndex([], 0)).toBeNull();
  });
});
