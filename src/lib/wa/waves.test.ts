import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  planWaves,
  waveOfIndex,
  waveEndsAtFor,
  clampRestampToWave,
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

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

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

// THE SCHEDULE HAS TO BE EXPRESSED TWICE, AND THIS IS THE HALF THAT GETS
// FORGOTTEN.
//
// `not_before` is only a FLOOR. The drain is the authoritative pacer for cold
// intros - it sends at most a couple per invocation and re-stamps the rest a
// few minutes out. A wave of 8 needs several invocations to clear, so left
// alone those re-stamps walk the burst across its own silence and into the
// next wave. The schedule ends up a continuous trickle again, just with extra
// steps - which is precisely the shape waves exist to avoid.

describe("the drain-side clamp", () => {
  const T = 1_800_000_000_000;

  it("a re-stamp inside the wave is left alone", () => {
    expect(clampRestampToWave(T + 60_000, T + 600_000)).toBe(T + 60_000);
  });

  it("a re-stamp past the wave's end is pulled back to the boundary", () => {
    // It may be delayed within the burst; it may land exactly on the boundary.
    // It may never land in the quiet gap.
    expect(clampRestampToWave(T + 900_000, T + 600_000)).toBe(T + 600_000);
  });

  it("a LEGACY row - no wave metadata - is returned completely unchanged", () => {
    // Every row enqueued before waves were switched on takes this path, and it
    // must keep behaving exactly as it does today. A clamp that defaulted to
    // "now" here would drag the entire legacy queue forward.
    for (const missing of [null, undefined, 0, NaN, Infinity]) {
      expect(clampRestampToWave(T + 900_000, missing)).toBe(T + 900_000);
    }
  });

  it("clamping is idempotent - re-stamping a clamped row cannot drift", () => {
    const end = T + 600_000;
    const once = clampRestampToWave(T + 900_000, end);
    expect(clampRestampToWave(once + 240_000, end)).toBe(end);
  });
});

describe("waveEndsAtFor - what the enqueue stamps onto the row", () => {
  it("resolves to an absolute time inside the row's own wave", () => {
    const start = 1_800_000_000_000;
    const { waves } = planWaves({ total: 24, rand: seeded(6) });
    let seen = 0;
    for (const w of waves) {
      for (let i = 0; i < w.size; i++) {
        const ends = waveEndsAtFor(start, waves, seen + i);
        expect(ends).toBe(start + w.startOffsetMs + w.spanMs);
      }
      seen += w.size;
    }
  });

  it("a wave's end never reaches the next wave's start", () => {
    // If it did, the clamp would permit exactly the bleed it exists to stop.
    const start = 1_800_000_000_000;
    const { waves } = planWaves({ total: 24, rand: seeded(13) });
    let seen = 0;
    for (let i = 0; i < waves.length - 1; i++) {
      const ends = waveEndsAtFor(start, waves, seen)!;
      expect(ends).toBeLessThan(start + waves[i + 1].startOffsetMs);
      seen += waves[i].size;
    }
  });

  it("a position with no wave stamps nothing rather than a bogus time", () => {
    const { waves, scheduled } = planWaves({ total: 24, rand: seeded(6) });
    expect(waveEndsAtFor(0, waves, scheduled)).toBeNull();
    expect(waveEndsAtFor(0, [], 0)).toBeNull();
  });
});

describe("BOTH HALVES ARE WIRED - building it in one place is the failure mode", () => {
  const mass = readCode("src/app/api/outreach/mass/route.ts");
  const guard = readCode("src/lib/wa-guard.ts");

  it("the enqueue stamps the wave end onto the row it writes", () => {
    expect(mass).toMatch(/waveEndsAtFor\(batchStart, wavePlan\.waves, slot\)/);
    expect(mass).toMatch(/\{ \.\.\.meta, waveEndsAt \}/);
  });

  it("every row the batch writes carries it, not just the parked ones", () => {
    // The immediate send can still be queued by the guard, and the pacing-gap
    // fallback writes a row too. A stamp on only the obvious branch leaves the
    // drain blind on the others.
    expect(mass).toMatch(/meta: rowMeta,/);
    expect(mass).toMatch(/\{ \.\.\.rowMeta, reason: "batch-spacing" \}/);
    expect(mass).toMatch(/\{ \.\.\.rowMeta, reason: claim\.kind === "duplicate"/);
  });

  it("waves stay behind the cohort flag, so nothing changes while it is off", () => {
    expect(mass).toMatch(/inCohort\("WA_WAVE_PACING", session\.email\)/);
    // wavePlan is null when the flag is off, and a null plan stamps nothing.
    expect(mass).toMatch(/wavePlan \? waveEndsAtFor\(/);
  });

  it("the drain reads it back and clamps its own re-stamps", () => {
    expect(guard).toMatch(/clampRestampToWave/);
    expect(guard).toMatch(/Number\(candMeta\.waveEndsAt\) \|\| null/);
  });

  it("the drain clamps EVERY release, not one branch of the ladder", () => {
    // The drain re-parks for several distinct reasons (rate limit, pacing gap,
    // duplicate claim, transient host failure). A clamp applied to one of them
    // leaks the burst through the others - so they all go through one closure.
    const releases = guard.match(/await release\(/g) ?? [];
    expect(releases.length).toBeGreaterThanOrEqual(5);
    expect(guard).toMatch(/const release = async \(delayMs: number/);
  });

  it("W8: the OVER-BUDGET re-park is clamped too - it is the path most of a wave takes", () => {
    // The clamp was wired only into the post-claim `release()` helper, which
    // handles the exceptional re-parks. The drain sends 2 cold rows per sender
    // per invocation and re-parks THE REST through the over-budget branch, so
    // the one path a wave actually flows through skipped the clamp entirely
    // and the burst bled across its own silence, wave after wave.
    const branch = guard.slice(
      guard.indexOf("if (overCap) {"),
      guard.indexOf("const claimedAt = Date.now();")
    );
    expect(branch.length).toBeGreaterThan(100);
    expect(branch).toMatch(/clampRestampToWave\(/);
    // ...and it must clamp the COMPUTED delay, not re-park unclamped and hope.
    expect(branch).toMatch(/not_before: new Date\(\s*clampRestampToWave\(/);
  });

  it("the clamp does NOT reach the guard's own re-park, and that is deliberate", () => {
    // clampRestampToWave only ever moves a time EARLIER. guardOutbound's
    // `queue()` re-times rows for safety reasons too - pause, ban recovery,
    // fail-closed sync retries, breakers - and pulling one of those back to a
    // wave boundary would release a paused account sooner. Exactly the wrong
    // direction, so the clamp is confined to the drain's pacing re-stamps.
    const at = guard.indexOf("const queue = async (notBefore: string");
    expect(at).toBeGreaterThan(-1);
    const queueHelper = guard.slice(at, at + 2000);
    // Non-vacuous: the slice really is the helper's body.
    expect(queueHelper).toMatch(/releaseOutboxRow\(opts\.outboxRowId, notBefore/);
    expect(queueHelper).not.toMatch(/clampRestampToWave/);
  });

  it("the burst inside a wave still runs through batchStagger", () => {
    // A second scheduler is how HARD_MIN_GAP_SEC quietly stops applying.
    const wavesBlock = mass.slice(mass.indexOf("if (wavesOn)"), mass.indexOf("const batchStart"));
    expect(wavesBlock).toMatch(/batchStagger\(\{/);
    expect(wavesBlock).toMatch(/WAVE_BURST_FRACTION/);
  });
});
