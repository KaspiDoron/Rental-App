import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { addDays } from "./rental-window";
import { formatDateRange } from "./clock";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const builder = readCode("src/components/RequestBuilder.tsx");

// M8 / I-8: THE DATES WERE BURIED IN STEP 3 OF 4.
//
// The one fact that decides whether a shop can answer at all - when the rental
// starts - was visible on a single screen of a four-screen carousel, and off
// screen for the rest of the flow. Since Tier 0.4 that date also rides on the
// wire in the opener, so a window the traveller cannot see is a window they
// cannot check against what the shops were actually asked.

describe("the rental window is not a step", () => {
  it("the date field lives OUTSIDE every `current === ...` step block", () => {
    // The panel renders above the progress rail, so it is on screen no matter
    // which step the carousel is showing.
    const panelAt = builder.indexOf("<StartDateField");
    const railAt = builder.indexOf("{steps.map(");
    expect(panelAt).toBeGreaterThan(-1);
    expect(railAt).toBeGreaterThan(-1);
    expect(panelAt).toBeLessThan(railAt);
  });

  it("the duration travels with it - one thought, one panel", () => {
    const dateAt = builder.indexOf("<StartDateField");
    const durationAt = builder.indexOf("<DurationField");
    const railAt = builder.indexOf("{steps.map(");
    expect(durationAt).toBeGreaterThan(dateAt);
    expect(durationAt).toBeLessThan(railAt);
  });

  it("the specs step no longer carries the date", () => {
    const specs = builder.slice(
      builder.indexOf('{current === "specs" &&'),
      builder.indexOf('{current === "extras" &&')
    );
    expect(specs).not.toMatch(/StartDateField|DurationField/);
  });

  it("the same-day plan notice moved with the picker, not away from it", () => {
    // A silent server-side clamp that moves the date after the traveller has
    // pressed search is the failure this line exists to prevent, so it has to
    // sit where the date is chosen.
    const panel = builder.slice(0, builder.indexOf("{steps.map("));
    expect(panel).toMatch(/maxStartDate === today/);
    expect(panel).toMatch(/same-day rentals/);
  });
});

describe("the return date is emitted, and derived", () => {
  it("the builder now sends returnDate", () => {
    // It is a real field on StructuredRFQ - the opener interpolates it,
    // clampRfqWindow preserves the span across a clamp, and the summary bar
    // reads it - and the builder never set it, so all three read undefined.
    expect(builder).toMatch(/^\s*returnDate,$/m);
  });

  it("it is DERIVED from the duration, never a second input", () => {
    // Two inputs for one fact is how this app got four disagreeing shop
    // counters. There is exactly one date input in the builder.
    expect(builder).toMatch(/const returnDate = addDays\(startDate, days\)/);
    expect(builder.match(/<StartDateField/g)?.length ?? 0).toBe(1);
  });

  it("the arithmetic is the UTC-anchored label helper, not a local Date", () => {
    // `new Date(...)` day arithmetic returns a day early for every traveller
    // east or west of Greenwich, and DST moves it again twice a year.
    expect(builder).toMatch(/addDays/);
    expect(builder).not.toMatch(/new Date\(.*86_?400/);
  });

  it("the derivation agrees with the shared helper", () => {
    expect(addDays("2026-08-12", 4)).toBe("2026-08-16");
    // A month boundary, because that is where hand-rolled arithmetic breaks.
    expect(addDays("2026-08-30", 4)).toBe("2026-09-03");
  });

  it("it re-derives when either input moves", () => {
    // Both are in the effect's dependency list, so the parent never holds a
    // return date computed against a start date the traveller has changed.
    const deps = builder.slice(builder.indexOf("}, [vehicle, transmission"));
    expect(deps.slice(0, 200)).toMatch(/startDate, returnDate/);
  });
});

describe("no raw ISO date reaches the traveller", () => {
  it("the recap chip uses the shared range formatter", () => {
    expect(builder).toMatch(/formatDateRange\(startDate, returnDate\)/);
    // The old chip printed the ISO string straight out of state.
    expect(builder).not.toMatch(/\{t\("from"\)\} \{startDate\}/);
  });

  it("the formatter states a window, and collapses when there is none", () => {
    expect(formatDateRange("2026-08-12", "2026-08-16")).toMatch(/-/);
    expect(formatDateRange("2026-08-12", "2026-08-12")).not.toMatch(/-/);
  });
});
