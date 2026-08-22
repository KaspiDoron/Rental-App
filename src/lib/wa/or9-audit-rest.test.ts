import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MAX_FANOUT, planSiblingRebargain } from "../negotiation/rebargain";
import { effectiveHourCap, warmupFactor, planCapacity } from "./capacity";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// The rest of the pile the audit fleet never reviewed.

describe("H1 the stagger and the drain agree about a new number", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("THE REGRESSION: the stagger floored at the UN-ramped plan budget", () => {
    // The cap the drain enforces goes through dynamicHourCap -> effectiveHourCap,
    // which wave D made genuinely ramped. effectiveHourlyCap - the helper the
    // batch stagger uses - floored at planCapacity(plan).newContacts, the FULL
    // budget with no warm-up. So a day-0 ultra batch was staggered as though 24
    // sends an hour were available while the drain would honour about half: the
    // tail is stamped for a slot that gets refused, re-parked and stamped again,
    // which is the bouncing this function's own comment says it prevents.
    expect(guard).toMatch(/const rampedBudget = Math\.max\(/);
    expect(guard).toMatch(/planCapacity\(resolvedPlan\)\.newContacts \* warmupMultiplier\(rep, p\)/);
    expect(guard).not.toMatch(/return Math\.max\(trimmed, planCapacity\(resolvedPlan\)\.newContacts\);/);
  });

  it("EXECUTED: the enforced cap really is lower on day 0 than when warm", () => {
    // The assertion that would have caught this AND the original wave-D defect.
    // effectiveHourCap is what dynamicHourCap calls, i.e. what the drain honours.
    const WARMUP_DAYS = 7;
    for (const plan of ["pro", "ultra"] as const) {
      const trustBase = 4; // a new number's trust floor
      const day0 = effectiveHourCap(plan, trustBase, 0, WARMUP_DAYS);
      const warm = effectiveHourCap(plan, trustBase, WARMUP_DAYS, WARMUP_DAYS);
      expect(day0, `${plan} day 0 must be below its warm ceiling`).toBeLessThan(warm);
    }
  });

  it("EXECUTED: the stagger's own floor moves with age too", () => {
    // Reproduce the floor both ways and show they now track each other. The
    // source assertion above anchors this to the real expression.
    const WARMUP_DAYS = 7;
    const budget = planCapacity("ultra").newContacts;
    const oldFloor = budget; // flat, whatever the age
    const newFloor = (ageDays: number) =>
      Math.max(1, Math.round(budget * warmupFactor(ageDays, WARMUP_DAYS)));
    expect(newFloor(0)).toBeLessThan(oldFloor);
    expect(newFloor(WARMUP_DAYS)).toBe(oldFloor);
    // ...and the day-0 floor no longer exceeds what the drain will allow.
    expect(newFloor(0)).toBeLessThanOrEqual(effectiveHourCap("ultra", 4, 0, WARMUP_DAYS));
  });
});

describe("H2 one truncation cannot serve two opposite readers", () => {
  const engine = readCode("src/lib/graph/engine.ts");

  it("the session table keeps its dearest rows, not only its cheapest", () => {
    // planSiblingRebargain reads this list and sorts it DEAREST-first: the
    // shops with the most room to move are the ones worth re-approaching when a
    // cheaper quote lands. Sorting cheapest-first fixed the leverage card and
    // handed the swarm precisely the rows it had just discarded.
    expect(engine).toMatch(/const head = ranked\.slice\(0, SESSION_TABLE_CAP - REBARGAIN_TAIL\);/);
    expect(engine).toMatch(/const tail = ranked\.slice\(-REBARGAIN_TAIL\);/);
    // Deduped, or a board of exactly 10 would repeat rows.
    expect(engine).toMatch(/tail\.filter\(\(r\) => !seen\.has\(r\.vendorId\)\)/);
    // The reserved tail is sized to what the swarm can actually use.
    expect(engine).toMatch(/const REBARGAIN_TAIL = 4;/);
    expect(MAX_FANOUT).toBe(4);
  });

  it("EXECUTED: a 14-shop board still gives the re-bargain real targets", () => {
    // Model the shape: this shop at 300, thirteen rivals from 100 to 400. The
    // cheapest-first slice(0,10) would keep 100-190 and drop everything dearer,
    // so the dearest-first re-bargain got nothing above the new low.
    const rows = [
      { vendorId: "self", vendorName: "This", toNumber: "1", pricePerDay: 300, currency: "THB", isThisShop: true },
      ...Array.from({ length: 13 }, (_, i) => ({
        vendorId: `v${i}`,
        vendorName: `Shop ${i}`,
        toNumber: `9${i}`,
        pricePerDay: 100 + i * 25, // 100..400
        currency: "THB",
        isThisShop: false,
      })),
    ];
    const ranked = [...rows].sort((a, b) => {
      if (a.isThisShop !== b.isThisShop) return a.isThisShop ? -1 : 1;
      return a.pricePerDay - b.pricePerDay;
    });
    const CAP = 10, TAIL = 4;
    const head = ranked.slice(0, CAP - TAIL);
    const seen = new Set(head.map((r) => r.vendorId));
    const kept = [...head, ...ranked.slice(-TAIL).filter((r) => !seen.has(r.vendorId))];

    // A new low of 120 lands. The swarm should re-approach the dear shops.
    const targets = planSiblingRebargain({
      rows: kept,
      excludeVendorId: "self",
      newLowPerDay: 120,
      currency: "THB",
    });
    expect(targets.length).toBeGreaterThan(0);
    // ...and they are the DEAR ones, which is the whole point.
    expect(Math.max(...targets.map((t) => t.pricePerDay ?? 0))).toBeGreaterThanOrEqual(350);

    // The old behaviour, for contrast: cheapest-first truncation alone.
    const oldKept = ranked.slice(0, CAP);
    const oldTargets = planSiblingRebargain({
      rows: oldKept,
      excludeVendorId: "self",
      newLowPerDay: 120,
      currency: "THB",
    });
    expect(
      Math.max(...oldTargets.map((t) => t.pricePerDay ?? 0), 0),
      "the old slice could not reach the dear shops"
    ).toBeLessThan(350);
  });

  it("a board at or under the cap is returned whole, as before", () => {
    expect(engine).toMatch(/if \(ranked\.length <= SESSION_TABLE_CAP\) return ranked;/);
  });
});
