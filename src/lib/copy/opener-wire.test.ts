import { describe, it, expect } from "vitest";
import { compileOpener, formatRentalDate } from "./promptCompiler";
import type { StructuredRFQ } from "../types";

// THE WIRE TEXT, NOT THE POOLS.
//
// Every prior round tested the phrasing pools in isolation and every prior
// round missed what shops actually received, because the defects were in the
// COMPOSITION: a duration phrase that read "for 1 days", a vehicle line with
// stacked adjectives, and - the fatal one - no date anywhere.
//
// An opener that asks a price without saying when the rental starts is not a
// question. A shop owner cannot quote it. It is a rate-card request, which is
// what a reseller sends, so the honest reading from the other end is spam. On
// the enforcement axis that meters UNANSWERED new chats, a message nobody can
// answer is the most expensive kind there is - which makes this compiler fix
// a stronger anti-ban measure than any pacing constant.

const rfq = (over: Partial<StructuredRFQ> = {}): StructuredRFQ =>
  ({
    vehicleClass: "scooter",
    transmission: "automatic",
    engineSizeCc: 125,
    durationDays: 3,
    accessories: [],
    fulfillment: "pickup",
    startDate: "2026-08-12",
    returnDate: "2026-08-15",
    ...over,
  }) as StructuredRFQ;

const REGIONS = [undefined, "th", "ph", "vn", "id"] as const;

/** The compiled corpus this gate runs against: many seeds x many shapes. */
function corpus(over: Partial<StructuredRFQ> = {}): string[] {
  const out: string[] = [];
  for (const region of REGIONS) {
    for (let i = 0; i < 20; i++) {
      out.push(
        compileOpener(rfq(over), { threadId: "traveller@example.com", vendorId: `v${i}`, nonce: i }, region)
      );
    }
  }
  return out;
}

describe("formatRentalDate", () => {
  it("renders a human, unambiguous day-month", () => {
    expect(formatRentalDate("2026-08-12")).toBe("12 Aug");
    expect(formatRentalDate("2026-01-01")).toBe("1 Jan");
    expect(formatRentalDate("2026-12-31")).toBe("31 Dec");
  });

  it("NEVER renders numerically - 8/12 means two different days across our regions", () => {
    expect(formatRentalDate("2026-08-12")).not.toMatch(/\d+\/\d+/);
  });

  it("is timezone-proof: parsed as a calendar triple, not an instant", () => {
    // `new Date("2026-08-12")` is midnight UTC, which is 11 Aug anywhere west
    // of Greenwich. A rental date is a wall-clock fact about the shop's
    // calendar, so the day must never shift.
    expect(formatRentalDate("2026-08-12T00:00:00Z")).toBe("12 Aug");
    expect(formatRentalDate("2026-08-01")).toBe("1 Aug");
  });

  it("returns empty for anything unparseable rather than inventing a date", () => {
    for (const bad of ["", "tomorrow", "12/08/2026", "2026-13-01", "2026-08-99", undefined]) {
      expect(formatRentalDate(bad as string)).toBe("");
    }
  });
});

describe("every compiled opener is ANSWERABLE", () => {
  it("REPRODUCTION: a date reaches the wire in every single variant", () => {
    for (const text of corpus()) {
      expect(text, `no date in: ${text}`).toMatch(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
    }
  });

  it("states the return date when the traveller gave one", () => {
    for (const text of corpus()) {
      expect(text).toMatch(/12 Aug/);
      expect(text).toMatch(/15 Aug/);
    }
  });

  it("a range replaces the duration instead of repeating it", () => {
    // "12 Aug to 15 Aug 3 days total" said the same fact twice, in the register
    // of a form letter rather than a person texting.
    for (const text of corpus()) {
      const hasRange = /12 Aug\b[^.]*15 Aug/.test(text);
      if (hasRange) expect(text, text).not.toMatch(/\b3 days\b/);
    }
  });

  it("falls back to start-plus-duration when no return date is known", () => {
    for (const text of corpus({ returnDate: undefined })) {
      expect(text).toMatch(/12 Aug/);
      expect(text).toMatch(/\b3 days\b/);
    }
  });

  it("still compiles a whole message when the traveller gave no dates at all", () => {
    for (const text of corpus({ startDate: undefined, returnDate: undefined })) {
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

describe("the grammar defects that told every shop this was a template", () => {
  it('REPRODUCTION: no "for 1 days"', () => {
    for (const text of corpus({ durationDays: 1, returnDate: undefined })) {
      expect(text, text).not.toMatch(/\b1 days\b/);
    }
  });

  it("singular reads naturally for a one-day rental", () => {
    for (const text of corpus({ durationDays: 1, returnDate: undefined })) {
      expect(text).toMatch(/\b(1 day|a single day|one day|the one day)\b/);
    }
  });

  it("plural is correct for every other duration", () => {
    for (const d of [2, 3, 7, 30]) {
      for (const text of corpus({ durationDays: d, returnDate: undefined })) {
        expect(text, text).not.toMatch(new RegExp(`\\b${d} day\\b`));
      }
    }
  });

  it("no stranded politeness particle - the greeting swap used to eat the word", () => {
    for (const text of corpus()) {
      expect(text, text).not.toMatch(/^\s*(po|krub|ka)\b/i);
      expect(text, text).not.toMatch(/[!?.]\s+(po|krub|ka)!/i);
    }
  });

  it("no sentence fragment opening - a predicate needs its subject", () => {
    for (const text of corpus()) {
      expect(text, text).not.toMatch(/[?.]\s+(after|need|looking|hoping|want) /);
    }
  });

  it("no double spaces, no leaked placeholders, no markdown", () => {
    for (const text of corpus()) {
      expect(text).not.toMatch(/\s{2,}/);
      expect(text).not.toMatch(/\{|\}|undefined|NaN/);
      expect(text).not.toMatch(/\*\*|__/);
    }
  });

  it("uses only short hyphens", () => {
    for (const text of corpus()) {
      expect(text).not.toMatch(/[‐-―]/);
    }
  });
});

describe("the opener still varies per shop - the date must not flatten the matrix", () => {
  it("40 shops in one batch produce many distinct skeletons", () => {
    const texts = Array.from({ length: 40 }, (_, i) =>
      compileOpener(rfq(), { threadId: "traveller@example.com", vendorId: `shop-${i}`, nonce: 1 })
    );
    expect(new Set(texts).size).toBeGreaterThanOrEqual(30);
  });

  it("is deterministic - the same seed compiles the same text", () => {
    const seed = { threadId: "t", vendorId: "v", nonce: 7 };
    expect(compileOpener(rfq(), seed)).toBe(compileOpener(rfq(), seed));
  });
});
