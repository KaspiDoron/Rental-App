import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { extractQuotedPrices } from "./wa/price-extract";
import { pickRival, pickCheapestRival, type RivalOffer } from "./search-session";
import { validRivals } from "./negotiation/session-rivals";
import type { SessionShopRow } from "./graph/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// W5.2 - RIVAL INTEGRITY. The owner's "167" screenshot.
//
// A Thai draft cited "167 บาท/วัน สำหรับ 1 วัน" - 167 baht a day, for 1 day -
// a number no shop ever said. It was not a hallucination: a shop had quoted 500
// for 3 days, the extractor divided (Math.round(500/3) === 167 exactly) and
// stored the result as `offers.price_per_day` with NO marker that it was
// derived. `cheapestRivalFor` then handed it to another shop as a like-for-like
// rival for a ONE-day rental, and composeBargain welded the current duration
// onto it and forbade the model from softening it.
//
// Three separate holes, each pinned below: the extractor kept no provenance,
// the predicate ignored duration, and the guard designed to catch exactly this
// (`effective_daily_rate`) was declared, read, and never written by anything.

describe("REPRODUCTION: 500 for 3 days is not 167 a day", () => {
  it("the extractor still derives 167 - that arithmetic was never wrong", () => {
    const q = extractQuotedPrices("500 baht for 3 days", { durationDays: 1, localCurrency: "THB" });
    expect(q.offer?.pricePerDay).toBe(167);
  });

  it("...and now it says the 167 came from a THREE day package", () => {
    const q = extractQuotedPrices("500 baht for 3 days", { durationDays: 1, localCurrency: "THB" });
    expect(q.offer?.derivedFromDays).toBe(3);
  });

  it("a price the shop actually stated per day carries NO derived marker", () => {
    const q = extractQuotedPrices("250 baht per day", { durationDays: 3, localCurrency: "THB" });
    expect(q.offer?.pricePerDay).toBe(250);
    expect(q.offer?.derivedFromDays).toBeUndefined();
  });

  it("weekly and monthly packages carry their real span, not the traveller's", () => {
    const week = extractQuotedPrices("1400 baht per week", { durationDays: 2, localCurrency: "THB" });
    expect(week.offer?.derivedFromDays).toBe(7);
    const month = extractQuotedPrices("6000 baht per month", { durationDays: 2, localCurrency: "THB" });
    expect(month.offer?.derivedFromDays).toBe(30);
  });
});

describe("the rival predicate is duration-aware", () => {
  const base: RivalOffer = {
    vendorId: "shop-b",
    pricePerDay: 167,
    currency: "THB",
    vehicleKey: "scooter-125",
    createdAt: "2026-08-15T10:00:00Z",
    searchId: 7,
  };
  const args = {
    vendorId: "shop-a",
    currency: "THB",
    vehicleKey: "scooter-125",
    belowPrice: 300,
    sinceIso: "2026-08-15T09:00:00Z",
    searchId: 7,
  };

  it("REPRODUCTION: a 3-day package is NOT a rival for a 1-day rental", () => {
    const picked = pickRival([{ ...base, quoteBasisDays: 3 }], { ...args, durationDays: 1 });
    expect(picked).toBeNull();
  });

  it("an unknown rental length is treated as the shortest - fail closed", () => {
    expect(pickRival([{ ...base, quoteBasisDays: 3 }], args)).toBeNull();
  });

  it("the SAME package IS a rival once the traveller rents long enough", () => {
    const picked = pickRival([{ ...base, quoteBasisDays: 3 }], { ...args, durationDays: 3 });
    expect(picked?.pricePerDay).toBe(167);
  });

  it("...and it comes back saying it is arithmetic, not a quote", () => {
    const picked = pickRival([{ ...base, quoteBasisDays: 3 }], { ...args, durationDays: 3 });
    expect(picked?.derivedFromDays).toBe(3);
  });

  it("a per-day the shop actually typed needs no duration excuse", () => {
    const picked = pickRival([{ ...base, pricePerDay: 200 }], { ...args, durationDays: 1 });
    expect(picked?.pricePerDay).toBe(200);
    expect(picked?.derivedFromDays).toBeUndefined();
  });

  it("the old number-only signature still answers, so nothing else changed", () => {
    expect(pickCheapestRival([{ ...base, pricePerDay: 200 }], { ...args, durationDays: 1 })).toBe(200);
  });
});

describe("the session aggregator drops a package rival too", () => {
  const row = (over: Partial<SessionShopRow>): SessionShopRow => ({
    vendorId: "b",
    vendorName: "Other",
    pricePerDay: 167,
    currency: "THB",
    ...over,
  });

  it("a 3-day-derived rival never reaches a 1-day prompt", () => {
    const out = validRivals([row({ quoteBasisDays: 3 })], {
      excludeVendorId: "a",
      currency: "THB",
      durationDays: 1,
    });
    expect(out).toEqual([]);
  });

  it("it reaches a 3-day prompt WITH its provenance attached", () => {
    const out = validRivals([row({ quoteBasisDays: 3 })], {
      excludeVendorId: "a",
      currency: "THB",
      durationDays: 3,
    });
    expect(out).toHaveLength(1);
    expect(out[0].derivedFromDays).toBe(3);
  });

  it("an ordinary quoted rival is untouched", () => {
    const out = validRivals([row({ pricePerDay: 200 })], {
      excludeVendorId: "a",
      currency: "THB",
      durationDays: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].derivedFromDays).toBeUndefined();
  });
});

describe("the inert guard is now live, and the draft path has a numeric rail", () => {
  it("effective_daily_rate is WRITTEN, not only declared and read", () => {
    // It was in the schema and read by pickCheapestRival, so
    // `Math.min(effectiveDailyRate, pricePerDay)` always fell through to the
    // sticker price. A repo-wide search for a writer returned nothing.
    const loop = read("src/lib/agent-loop.ts");
    expect(loop).toMatch(/effective_daily_rate:/);
    expect(loop).toMatch(/quote_basis_days:/);
    expect(read("supabase/schema.sql")).toMatch(/offers\s+add column if not exists quote_basis_days/);
  });

  it("search_id survives the schema-graceful retry", () => {
    // pickCheapestRival REQUIRES searchId equality when the session id is
    // known, and search_id lived only on the widest insert attempt - so a row
    // that fell back was excluded from every rival lookup for the rest of the
    // hunt, minutes old or not.
    const loop = read("src/lib/agent-loop.ts");
    expect(loop).toMatch(/const base = \{ \.\.\.offerBase, search_id: searchId \}/);
    expect(loop).toMatch(/sbInsert\("offers", \[base\]\)/);
  });

  it("the bargain-draft route runs checkOutboundNumbers, not only runSafety", () => {
    const route = read("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/checkOutboundNumbers/);
    expect(route).toMatch(/citesAMatch/);
  });

  it("the draft's rival is the SERVER's, never the browser's number", () => {
    const route = read("src/app/api/bargain-draft/route.ts");
    // The client hint may no longer seed the value under a Math.min.
    expect(route).not.toMatch(/let rival: number \| undefined = body\.rivalPricePerDay/);
    expect(route).toMatch(/cheapestRivalQuoteFor/);
    expect(route).toMatch(/rival-hint-ignored/);
  });
});
