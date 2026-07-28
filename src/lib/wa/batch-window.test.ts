import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { batchStagger, HARD_MIN_GAP_SEC } from "./pacing";
import { BATCH_WINDOW_MINUTES, batchWindowMs, planCapacity } from "./capacity";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "IT SCHEDULED 7-8 MESSAGES FROM 16:26 ALL THE WAY TO 19:17."
//
// Nothing crashed. The schedule was assembled bottom-up - take the policy
// min-gap, add jitter, jump a whole hour whenever the hourly cap is reached -
// and whatever total came out was the answer. Every input was individually
// defensible and no code owned the sum, so a single drifted input stretched a
// three-minute job across an afternoon:
//
//   - `effectiveHourlyCap(...).catch(() => 3)`. A literal 3, smaller than
//     EVERY plan's own conversation budget, so one transient Supabase blip
//     split 8 shops into three hour-groups.
//   - An owner-raised `min_gap_seconds`, honoured per message with nothing
//     checking what it did to the batch.
//
// The fix is not a smaller number anywhere. It is that the batch now has a
// deadline it is scheduled TO.

describe("the batch has a deadline, and the code holds it", () => {
  it("the promise is declared once", () => {
    expect(BATCH_WINDOW_MINUTES).toBe(15);
    expect(batchWindowMs()).toBe(15 * 60_000);
  });

  it("every plan's FULL budget of shops lands inside the window", () => {
    for (const plan of ["free", "pro", "ultra"] as const) {
      const cap = planCapacity(plan);
      const { offsets } = batchStagger({
        count: cap.newContacts,
        hourCap: cap.hourCap,
        gapSec: 12,
        windowMs: batchWindowMs(),
      });
      const last = offsets[offsets.length - 1];
      expect(last, `${plan} overruns the batch window`).toBeLessThanOrEqual(batchWindowMs());
      // ...and nothing was pushed into a later hour group.
      expect(offsets.every((o) => o < 3600_000)).toBe(true);
    }
  });

  it("the hourly cap can never again fall back BELOW the plan's own budget", () => {
    // The literal 3 is what turned the reported batch into three hour-groups.
    const route = readCode("src/app/api/outreach/mass/route.ts");
    expect(route).toMatch(/const planHourCap = planCapacity\(session\.plan\)\.hourCap/);
    expect(route).toMatch(/effectiveHourlyCap\(session\.email, session\.plan\)\.catch\(\(\) => planHourCap\)/);
    expect(route).not.toMatch(/effectiveHourlyCap\([^)]*\)\.catch\(\(\) => 3\)/);
    for (const plan of ["free", "pro", "ultra"] as const) {
      expect(planCapacity(plan).hourCap).toBeGreaterThanOrEqual(planCapacity(plan).newContacts);
    }
  });

  it("a drifted policy gap is compressed toward the deadline, not obeyed blindly", () => {
    // 8 shops at a 25-minute gap is exactly the reported 3-hour spread.
    const drifted = batchStagger({ count: 8, hourCap: 10, gapSec: 1500, windowMs: batchWindowMs() });
    expect(drifted.compressed).toBe(true);
    expect(drifted.offsets[7]).toBeLessThanOrEqual(batchWindowMs());
  });

  it("but the ban-safety floor is never traded for the deadline", () => {
    const huge = batchStagger({ count: 400, hourCap: 400, gapSec: 12, windowMs: batchWindowMs() });
    expect(huge.gapSecUsed).toBe(HARD_MIN_GAP_SEC);
    // It runs long rather than sending faster than is safe - and it is the
    // schedule that gives, never the floor.
    expect(huge.offsets[399]).toBeGreaterThan(batchWindowMs());
  });

  it("both dispatch paths schedule through the same function", () => {
    // The route used the policy min-gap; the worker used a hardcoded 45s. Same
    // click, different duration, depending on which one ran it.
    expect(readCode("src/app/api/outreach/mass/route.ts")).toMatch(/batchStagger\(\{/);
    expect(readCode("services/workers/src/outreach.worker.ts")).toMatch(/batchStagger\(\{/);
    // ...and the superseded scheduler is gone, not left alongside.
    expect(readCode("src/lib/wa/pacing.ts")).not.toMatch(/export function cappedStaggerOffsets/);
  });

  it("the route states the promise back, so a caller can hold it to it", () => {
    const route = readCode("src/app/api/outreach/mass/route.ts");
    expect(route).toMatch(/batchWindowMinutes: BATCH_WINDOW_MINUTES/);
    expect(route).toMatch(/batchGapSeconds: schedule\.gapSecUsed/);
    expect(route).toMatch(/batchOverflow: schedule\.overflow/);
  });
});
