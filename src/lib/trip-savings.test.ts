import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { savingOf, toTrip, type TripInput } from "./trips";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE HEADLINE NUMBER ON THE TRIPS SCREEN WAS WRONG.
//
// `savingOf` computes `asked - paid`, and both of those are DAILY rates
// (`best.ask`, `best.pricePerDay`, `booking.perDay`). So `Trip.saved` was a
// per-day figure - which is the right number for the negotiation and the wrong
// one for a trip.
//
// Trips then summed it across trips under "Your travel savings" / "saved across
// N trips". A six-day rental haggled down 50 a day reported 50 instead of 300.
// The hero number was understated by exactly the trip length, on the single
// screen whose job is to say what the product achieved.
//
// The two are separate fields now. The percentage was always fine: it is
// scale-free, so per-day and per-trip give the same answer - which is why the
// trip CARDS, which show only `savedPct`, were never wrong.

const input = (over: Partial<TripInput> = {}): TripInput => ({
  id: "s1",
  startedAt: new Date().toISOString(),
  query: null,
  vehicleClass: "scooter",
  durationDays: 6,
  contacted: 3,
  replied: 2,
  isLatest: true,
  best: { pricePerDay: 200, ask: 250, currency: "THB" },
  booking: null,
  ...over,
});

describe("REPRODUCTION: a daily rate wearing the label of a trip total", () => {
  it("the per-day gap is what the negotiation produced", () => {
    expect(savingOf(input()).savedPerDay).toBe(50);
  });

  it("...and the TRIP saving is that gap times the days", () => {
    // The number the hero sums. It used to be 50.
    expect(savingOf(input()).saved).toBe(300);
  });

  it("a one-day rental is the case where the bug was invisible", () => {
    // Which is exactly why it survived: at durationDays=1 the two are equal.
    const s = savingOf(input({ durationDays: 1 }));
    expect(s.savedPerDay).toBe(50);
    expect(s.saved).toBe(50);
  });

  it("no duration means NO TOTAL - never the per-day figure as a fallback", () => {
    // Falling back would be the original defect restated: a smaller, wrong
    // number wearing the label of a bigger, right one.
    for (const d of [null, undefined, 0]) {
      const s = savingOf(input({ durationDays: d }));
      expect(s.savedPerDay, `days=${String(d)}`).toBe(50);
      expect(s.saved, `days=${String(d)} must not be totalled`).toBeNull();
    }
  });

  it("the percentage is unaffected, because a ratio has no units", () => {
    expect(savingOf(input()).savedPct).toBe(20);
    expect(savingOf(input({ durationDays: 30 })).savedPct).toBe(20);
  });

  it("a booking's own per-day price outranks the quote, and still totals", () => {
    const s = savingOf(
      input({
        booking: {
          vendorName: "Sun House",
          perDay: 180,
          total: 1080,
          currency: "THB",
          scheduledAt: null,
        },
      })
    );
    expect(s.savedPerDay).toBe(70);
    expect(s.saved).toBe(420);
  });

  it("no saving stays no saving - never a negative dressed as a win", () => {
    for (const best of [
      { pricePerDay: 250, ask: 250, currency: "THB" },
      { pricePerDay: 300, ask: 250, currency: "THB" },
      null,
    ]) {
      const s = savingOf(input({ best }));
      expect(s.saved).toBeNull();
      expect(s.savedPerDay).toBeNull();
    }
  });

  it("both fields reach the Trip, so a card can show either honestly", () => {
    const trip = toTrip(input(), Date.now());
    expect(trip.savedPerDay).toBe(50);
    expect(trip.saved).toBe(300);
    expect(trip.savedPct).toBe(20);
  });
});

describe("the hero sums the trip total", () => {
  const page = readCode("src/app/deals/page.tsx");

  it("it adds `saved`, which is now the whole-rental figure", () => {
    expect(page).toMatch(/saved \+= tr\.saved;/);
  });

  it("a trip with no total is left out, not counted at its daily rate", () => {
    // `tr.saved` is null without a duration, so the truthiness guard skips it
    // and `counted` - which the caption reports - stays honest about coverage.
    expect(page).toMatch(/if \(tr\?\.saved && tr\.saved > 0\)/);
    expect(page).toMatch(/counted \+= 1;/);
  });

  it("the cards show the PERCENTAGE, which is why they were never wrong", () => {
    expect(page).toMatch(/trip\.savedPct != null/);
  });
});
