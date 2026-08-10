import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { formatRentalDate, formatDateRange } from "./clock";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// I-8 / M24: THE SUMMARY HEADER SAID NOTHING ABOUT WHEN.
//
// The collapsed bar showed the free-text request, the origin and the radius on
// a product whose entire job is a DATED rental. A traveller who picked the
// wrong month had no way to notice short of re-opening the form - and since
// Tier 0.4 the dates also ride on the wire in the opener, so a mismatch here is
// a mismatch in what the shops were asked.

describe("rental dates are parsed as LOCAL, not UTC", () => {
  it("keeps the day the picker showed", () => {
    // `new Date("2026-08-12")` is specified to parse date-only strings as UTC
    // MIDNIGHT, so every traveller west of Greenwich would see 11 Aug for a
    // rental they set to the 12th. Splitting the parts avoids that entirely.
    const label = formatRentalDate("2026-08-12");
    expect(label).toMatch(/12/);
    expect(label).not.toMatch(/11/);
  });

  it("returns empty for anything unparseable, so a caller can && it away", () => {
    for (const bad of ["", "   ", "not-a-date", "2026-8-2", "12/08/2026", null, undefined]) {
      expect(formatRentalDate(bad as string)).toBe("");
    }
  });
});

describe("the rental window is written ONE way", () => {
  it("renders a real range", () => {
    const out = formatDateRange("2026-08-12", "2026-08-15");
    expect(out).toMatch(/12/);
    expect(out).toMatch(/15/);
    expect(out).toContain(" - ");
  });

  it("collapses to the start when the end is missing or the same day", () => {
    const start = formatRentalDate("2026-08-12");
    expect(formatDateRange("2026-08-12", undefined)).toBe(start);
    expect(formatDateRange("2026-08-12", "2026-08-12")).toBe(start);
  });

  it("no start means no window at all - never a half-rendered range", () => {
    expect(formatDateRange(undefined, "2026-08-15")).toBe("");
    expect(formatDateRange("", "2026-08-15")).toBe("");
  });

  it("uses only short hyphens", () => {
    expect(formatDateRange("2026-08-12", "2026-08-15")).not.toMatch(/[‐-―]/);
  });
});

describe("the header states the actual query", () => {
  const bar = readCode("src/components/SearchSummaryBar.tsx");
  const page = readCode("src/app/page.tsx");

  it("the bar renders the window and the duration", () => {
    expect(bar).toMatch(/formatDateRange\(startDate, endDate\)/);
    expect(bar).toMatch(/dates \? ` · 📅 \$\{dates\}` : ""/);
    expect(bar).toMatch(/days === 1 \? t\("day"\) : t\("days"\)/);
  });

  it("ABSENT DATES RENDER AS NOTHING, not as a placeholder", () => {
    // A search restored from before dates existed is legitimately dateless, and
    // a "-" there would read as a bug rather than as an absence.
    expect(bar).toMatch(/dates \? /);
    expect(bar).not.toMatch(/dates \|\| "—"|dates \?\? "-"/);
  });

  it("the dates come from the COMPILED RFQ, not the live form state", () => {
    // The collapsed bar describes the query that produced the results below it;
    // the form may already have been edited without re-searching.
    expect(page).toMatch(/startDate=\{rfq\?\.startDate\}/);
    expect(page).toMatch(/endDate=\{rfq\?\.returnDate\}/);
    expect(page).toMatch(/durationDays=\{rfq\?\.durationDays\}/);
  });

  it("a zero or missing duration is not rendered as '0 days'", () => {
    expect(bar).toMatch(/\(durationDays \?\? 0\) > 0/);
  });
});

describe("M9/M1: the search CTA has no silent dead end", () => {
  const page = readCode("src/app/page.tsx");

  it("an empty request says WHY instead of returning silently", () => {
    // The two guards after it (unlinked WhatsApp, no coordinates) were already
    // honest; this one did nothing at all, which reads as a broken button.
    expect(page).toMatch(/if \(!structuredFields && !requestText\.trim\(\)\) \{/);
    expect(page).toMatch(/Tell me what you are looking for first/);
  });

  it("it scrolls the user to the control that needs them, like its neighbours", () => {
    const block = page.slice(
      page.indexOf("if (!structuredFields && !requestText.trim())"),
      page.indexOf("if (!structuredFields && !requestText.trim())") + 500
    );
    expect(block).toMatch(/data-tour='request'/);
    expect(block).toMatch(/scrollIntoView/);
  });

  it("the location guard it now matches is still intact", () => {
    // Regression guard: the honest no-coordinates path predates this and must
    // survive the edit above it.
    expect(page).toMatch(/Set your location first - allow GPS or type your hotel \/ area\./);
  });

  it("the new string reached the translation catalogue", () => {
    // A user-facing string outside the catalogue is a string t() refuses to
    // queue, so it would ship English-only in every language.
    const catalog = readCode("src/lib/i18n-catalog.ts");
    expect(catalog).toMatch(/Tell me what you are looking for first/);
  });
});
