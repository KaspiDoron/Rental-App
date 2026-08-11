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
const field = readCode("src/components/RentalWindowField.tsx");

// M8 / I-8: THE DATES WERE BURIED IN STEP 3 OF 4.
//
// The one fact that decides whether a shop can answer at all - when the rental
// starts - was visible on a single screen of a four-screen carousel, and off
// screen for the rest of the flow. Since Tier 0.4 that date also rides on the
// wire in the opener, so a window the traveller cannot see is a window they
// cannot check against what the shops were actually asked.
//
// W-7 CARRIED THE SAME ARGUMENT ONE STEP FURTHER. Lifting the panel out of the
// carousel was not enough, because the carousel itself is mounted only under
// `{builderOpen && ...}` - so everyone who typed their request instead of
// tapping it still never saw a date. The window now lives in its own component
// that the PAGE renders in both input modes; these tests moved with it, and the
// claim they make is strictly stronger: it is not a step of the wizard, and it
// is not behind the wizard either. See rental-window-reach.test.ts.

describe("the rental window is not a step", () => {
  it("the date field is not inside the carousel at all", () => {
    // It used to render above the progress rail. It now renders above the
    // whole component - the builder has no date input left.
    expect(builder).not.toMatch(/<StartDateField|<DurationField/);
    expect(field).toMatch(/<StartDateField/);
  });

  it("the duration travels with it - one thought, one panel", () => {
    const dateAt = field.indexOf("<StartDateField");
    const durationAt = field.indexOf("<DurationField");
    expect(dateAt).toBeGreaterThan(-1);
    expect(durationAt).toBeGreaterThan(dateAt);
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
    expect(field).toMatch(/maxStartDate === today/);
    expect(field).toMatch(/same-day rentals/);
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
    // counters. There is exactly one date input in the whole search flow, and
    // both the reporting builder and the rendering field derive the return
    // date from it with the same helper.
    expect(builder).toMatch(/const returnDate = addDays\(startDate, days\)/);
    expect(field).toMatch(/const returnDate = addDays\(startDate, days\)/);
    expect(builder.match(/<StartDateField/g)?.length ?? 0).toBe(0);
    expect(field.match(/<StartDateField/g)?.length ?? 0).toBe(1);
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
