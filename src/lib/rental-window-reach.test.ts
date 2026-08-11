import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { clampRfqWindow, resolveWindow, localDay, addDays } from "./rental-window";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "FOR 4 DAYS" - STARTING WHEN? (W-7, the owner's item 7.)
//
// A previous pass gave the tap builder a real date picker and proved the date
// reaches the shop (start-date.test.ts). It shipped INSIDE `RequestBuilder`.
// `page.tsx` mounts that component only under `{builderOpen && ...}` - the tap
// mode, which is off by default and reached through a small text link. So the
// question "when does this rental start?" was only ever asked of people who
// took the non-default path.
//
// Everyone else - the whole free-text mode the placeholder invites - sent
// `{ text, timeZone }` and nothing else, while /api/profile's free-text branch
// destructured a `durationDays` no client had ever supplied. The start date on
// those requests was whatever an LLM happened to read out of a sentence, or
// absent, and the duration was the 3-day default. The page contained exactly
// one mention of `startDate` in ~4,300 lines.
//
// Two more defects sat in the same square metre and are pinned here too:
//
//   - The picker resolved its own bounds with NO timeZone, so `localDay`
//     defaulted to UTC while the server clamped in the device zone. A traveller
//     in UTC+7 before 07:00 was offered a "today" that was already yesterday
//     where they stood.
//   - `clampRfqWindow` returns `{adjusted, reason}`. /api/profile discarded
//     both, so a date the server moved just looked like the traveller had
//     mistyped one.

describe("REPRODUCTION: the window was resolved in the wrong day", () => {
  // 23:30 UTC. In Bangkok (UTC+7) it is already 06:30 the NEXT day.
  const NOW = Date.parse("2026-08-11T23:30:00Z");

  it("UTC and the device zone disagree about what day it is", () => {
    expect(localDay(NOW)).toBe("2026-08-11");
    expect(localDay(NOW, "Asia/Bangkok")).toBe("2026-08-12");
  });

  it("so a zone-less picker offered a free traveller a date the server refuses", () => {
    // What the picker computed (no timeZone - the defect).
    const picker = resolveWindow({ plan: "free", nowMs: NOW });
    expect(picker.startDate).toBe("2026-08-11");
    // The free plan is same-day only, so this is also its ceiling: the picker
    // could not even offer the traveller's real today.
    expect(picker.maxStartDate).toBe("2026-08-11");

    // What the server then did with that date, clamping in the device zone.
    const { rfq, adjusted, reason } = clampRfqWindow(
      { startDate: picker.startDate, durationDays: 4 },
      { plan: "free", nowMs: NOW, timeZone: "Asia/Bangkok" }
    );
    expect(adjusted, "the server silently rewrote the picker's own answer").toBe(true);
    expect(rfq.startDate).toBe("2026-08-12");
    // The explanation existed the whole time. Nobody passed it on.
    expect(reason).toBeTruthy();
  });

  it("with the zone, the picker and the authority agree and nothing is rewritten", () => {
    const picker = resolveWindow({ plan: "free", nowMs: NOW, timeZone: "Asia/Bangkok" });
    expect(picker.startDate).toBe("2026-08-12");
    const { adjusted } = clampRfqWindow(
      { startDate: picker.startDate, durationDays: 4 },
      { plan: "free", nowMs: NOW, timeZone: "Asia/Bangkok" }
    );
    expect(adjusted).toBe(false);
  });

  it("a clamp keeps the trip LENGTH, so the return date is not silently lost", () => {
    const { rfq } = clampRfqWindow(
      { startDate: "2027-01-01", returnDate: addDays("2027-01-01", 6), durationDays: 6 },
      { plan: "free", nowMs: NOW, timeZone: "Asia/Bangkok" }
    );
    expect(rfq.startDate).toBe("2026-08-12");
    expect(rfq.returnDate).toBe("2026-08-18");
  });
});

describe("the window is asked once, for both input modes", () => {
  const page = readCode("src/app/page.tsx");
  const builder = readCode("src/components/RequestBuilder.tsx");
  const field = readCode("src/components/RentalWindowField.tsx");

  it("the picker is NOT inside the component that only the tap mode mounts", () => {
    // This is the whole defect in one assertion: the date input lived in a
    // subtree rendered under `{builderOpen && ...}`.
    expect(builder, "the builder still owns a date input").not.toMatch(/type="date"/);
    expect(builder, "the builder still owns the window state").not.toMatch(
      /useState\((?:today|4)\)/
    );
    expect(field).toMatch(/type="date"/);
  });

  it("the page renders it OUTSIDE the builderOpen branch", () => {
    const fieldAt = page.indexOf("<RentalWindowField");
    const gateAt = page.indexOf("{builderOpen && (");
    expect(fieldAt, "the page does not render the window field").toBeGreaterThan(0);
    expect(gateAt, "the builderOpen gate moved").toBeGreaterThan(0);
    expect(fieldAt, "the window is still behind the tap-mode gate").toBeLessThan(gateAt);
  });

  it("the builder reports the page's window rather than owning a second one", () => {
    expect(builder).toMatch(/startDate: string;/);
    expect(builder).toMatch(/days: number;/);
    expect(page).toMatch(/startDate=\{startDate \|\| planWindow\.startDate\}/);
    expect(page).toMatch(/days=\{days\}/);
  });

  it("the picker resolves in the DEVICE's zone, not Greenwich's", () => {
    expect(field).toMatch(/timeZone: mounted \? deviceTimeZone\(\) : undefined/);
  });

  it("the typed path posts the window it is showing", () => {
    expect(page).toMatch(/startDate: startDate \|\| planWindow\.startDate, durationDays: days/);
  });

  it("...but only once the traveller has actually set it", () => {
    // An untouched default must not out-rank a date stated in the request
    // itself ("from the 20th for a week"), which the profiler does parse.
    expect(page).toMatch(/windowTouched && !structuredFields/);
  });
});

describe("the server says what it did to the date", () => {
  const route = readCode("src/app/api/profile/route.ts");
  const page = readCode("src/app/page.tsx");
  const field = readCode("src/components/RentalWindowField.tsx");

  it("applyWindow no longer throws the decision away", () => {
    // It used to return `clampRfqWindow(...).rfq` - the adjustment and its
    // reason were computed and dropped on the floor.
    expect(route).not.toMatch(/\)\.rfq;/);
    expect(route).toMatch(/windowAdjusted: decided\.adjusted/);
    expect(route).toMatch(/windowReason: decided\.reason \?\? null/);
  });

  it("both request paths report it - the tap path clamps too", () => {
    expect(route.match(/windowAdjusted: decided\.adjusted/g) ?? []).toHaveLength(2);
  });

  it("an explicit pickup date overrides the parse, and drags the return with it", () => {
    expect(route).toMatch(/requestedStart\(body\?\.startDate\)/);
    expect(route).toMatch(/returnDate: addDays\(start, profiled\.durationDays\)/);
  });

  it("and the traveller is told, at the control that now disagrees with them", () => {
    expect(page).toMatch(/setWindowNote\(pData\.windowAdjusted \? pData\.windowReason \?\? null : null\)/);
    expect(field).toMatch(/adjustedReason/);
    // The reason is composed on the server and one of its forms interpolates a
    // day count, so it can never be a catalogue literal - it has to go through
    // the shared-text path or it renders in English for everyone.
    expect(field).toMatch(/tShared\(adjustedReason\)/);
  });

  it("the picker then shows the window the search actually ran with", () => {
    expect(page).toMatch(/if \(pData\.rfq\?\.startDate\) \{/);
    expect(page).toMatch(/setStartDate\(pData\.rfq\.startDate\)/);
  });
});
