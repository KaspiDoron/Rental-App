import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveWindow, clampRfqWindow, PLAN_DAYS_AHEAD } from "./rental-window";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "FOR 4 DAYS" - STARTING WHEN?
//
// Every rental request this app has ever sent carried a DURATION and no date.
// `StructuredRFQ.startDate` exists, and the entire downstream reads it:
//
//   agents.ts:328   `rfq.startDate ? prettyDate(rfq.startDate) : ""` in the opener
//   agents.ts:2042  "N days from <date>"
//   rental-window   resolveWindow / clampRfqWindow, plan-tiered lead time
//   traveller-disclosure.ts:113,208
//
// ...but `RequestBuilder` collected `days` and never set `startDate`, so it was
// undefined on every request and every one of those reads took its empty
// branch. A shop was asked for a four-day rental with no beginning.
//
// This is the plan window's first UI consumer, so the tests below pin BOTH
// halves: the picker offers only what the plan allows, and the date reaches the
// RFQ that the composer reads.

describe("REPRODUCTION: a date is collected, not only a count", () => {
  const builder = readCode("src/components/RequestBuilder.tsx");
  const field = readCode("src/components/RentalWindowField.tsx");

  it("startDate is in the reported RFQ fields", () => {
    // The one line whose absence made every downstream read dead.
    expect(builder).toMatch(/durationDays: days,\s*\n\s*startDate,/);
  });

  it("...and a change to it re-reports, or the parent keeps the stale date", () => {
    const deps = /\}, \[vehicle, transmission, cc, carType, days, ([^\]]*)\]\);/.exec(builder);
    expect(deps, "the live-report effect's dep list moved").toBeTruthy();
    expect(deps![1]).toContain("startDate");
  });

  it("the picker is bounded by the plan window, not free-form", () => {
    // W-7 moved the picker OUT of the builder (see session-window.test.ts for
    // why), so the bounds are pinned where they now live. Same claim, same
    // authority, one file across.
    expect(field).toMatch(/resolveWindow\(\{/);
    expect(field).toMatch(/min=\{min\}/);
    expect(field).toMatch(/max=\{max\}/);
    expect(readCode("src/app/page.tsx")).toMatch(/maxStartDate=\{planWindow\.maxStartDate\}/);
  });

  it("the page hands the picker the signed-in plan", () => {
    expect(readCode("src/app/page.tsx")).toMatch(/usePlanWindow\(session\?\.plan\)/);
  });
});

describe("the window the picker is bounded by", () => {
  // 2026-08-02T12:00:00Z, a fixed instant - Date.now() in a test is a flake.
  const NOW = Date.parse("2026-08-02T12:00:00Z");

  it("free books today and only today", () => {
    const w = resolveWindow({ plan: "free", nowMs: NOW, timeZone: "UTC" });
    expect(w.maxStartDate).toBe(w.startDate);
    expect(w.daysAhead).toBe(0);
    expect(PLAN_DAYS_AHEAD.free).toBe(0);
  });

  it("pro and ultra book ahead, so their pickers open up", () => {
    const pro = resolveWindow({ plan: "pro", nowMs: NOW, timeZone: "UTC" });
    const ultra = resolveWindow({ plan: "ultra", nowMs: NOW, timeZone: "UTC" });
    expect(pro.maxStartDate).toBe("2026-09-01");
    expect(ultra.maxStartDate).toBe("2027-01-29");
    expect(pro.maxStartDate < ultra.maxStartDate).toBe(true);
  });

  it("an unknown plan is treated as free - the picker never over-promises", () => {
    const w = resolveWindow({ plan: "enterprise-tier-9", nowMs: NOW, timeZone: "UTC" });
    expect(w.maxStartDate).toBe(w.startDate);
  });

  it("a date past the plan's ceiling is clamped with an honest reason", () => {
    const w = resolveWindow({
      plan: "free",
      requested: "2026-12-25",
      nowMs: NOW,
      timeZone: "UTC",
    });
    expect(w.adjusted).toBe(true);
    expect(w.startDate).toBe("2026-08-02");
    expect(w.reason).toMatch(/same-day/i);
  });

  it("the server still clamps whatever the client sends - the picker is not the authority", () => {
    // A tampered or stale client cannot buy lead time it has not paid for.
    const { rfq, adjusted } = clampRfqWindow(
      { startDate: "2027-06-01", durationDays: 4 },
      { plan: "free", nowMs: NOW, timeZone: "UTC" }
    );
    expect(adjusted).toBe(true);
    expect(rfq.startDate).toBe("2026-08-02");
  });
});

describe("the date reaches the shop", () => {
  it("the opener composer interpolates it when present", () => {
    // Both reads take their empty branch on a `startDate`-less RFQ, which is
    // what every request in production has been until now.
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/rfq\.startDate \? prettyDate\(rfq\.startDate\) : ""/);
    expect(agents).toMatch(/from \$\{prettyDate\(rfq\.startDate\)\}/);
  });

  it("the new copy is in the catalogue, or it ships untranslated", () => {
    // t() now refuses anything outside the catalogue (see i18n-gate), so new UI
    // strings that were not regenerated render in English for everyone.
    const catalog = read("src/lib/i18n-catalog.ts");
    // M8 renamed the picker's labels when the dates left the carousel: the
    // panel is always on screen now, so "From ... For ... Back on ..." reads as
    // one window instead of two questions asked mid-wizard.
    for (const s of [
      "From",
      "For",
      "Back on",
      "Your plan arranges same-day rentals - Pro and Ultra book ahead.",
    ]) {
      expect(catalog, `missing from the catalogue: "${s}"`).toContain(JSON.stringify(s));
    }
  });
});
