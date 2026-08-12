import { describe, it, expect } from "vitest";
import { toTrip, outcomeOf, savingOf, previewTrip, visibleTrips, type TripInput } from "./trips";

const NOW = Date.parse("2026-07-27T09:00:00.000Z");

const base: TripInput = {
  id: "41",
  startedAt: "2026-07-26T08:00:00.000Z",
  query: "automatic 125cc scooter",
  vehicleClass: "scooter",
  contacted: 8,
  replied: 5,
  best: null,
  booking: null,
  isLatest: false,
  lastEventAt: Date.parse("2026-07-26T09:00:00.000Z"),
};

describe("a trip has an OUTCOME - a session never did", () => {
  it("a booking is the strongest fact there is", () => {
    const t = toTrip(
      {
        ...base,
        booking: {
          vendorName: "Joh's",
          perDay: 400,
          total: 1600,
          currency: "PHP",
          scheduledAt: null,
        },
      },
      NOW
    );
    expect(t.outcome).toBe("booked");
    expect(t.headline).toMatch(/Booked a scooter/);
  });

  it("a finished hunt does NOT look like an abandoned one", () => {
    // The whole complaint: a session could only say what was happening right
    // now, so every past hunt rendered identically whatever became of it.
    const quoted = toTrip({ ...base, best: { pricePerDay: 500, ask: 700, currency: "PHP" } }, NOW);
    const nothing = toTrip({ ...base, contacted: 0, replied: 0 }, NOW);
    expect(quoted.outcome).toBe("quoted");
    expect(nothing.outcome).toBe("abandoned");
    expect(quoted.headline).not.toBe(nothing.headline);
  });

  it("contacted shops that never answered are named honestly", () => {
    expect(outcomeOf({ ...base, replied: 0 }, NOW)).toBe("no-answer");
  });

  it("the CURRENT hunt with recent activity is live", () => {
    expect(outcomeOf({ ...base, isLatest: true, lastEventAt: NOW - 60_000 }, NOW)).toBe("negotiating");
    // ...but a stale "latest" is not pretended to be live.
    expect(outcomeOf({ ...base, isLatest: true, lastEventAt: NOW - 4 * 3600_000 }, NOW)).not.toBe("negotiating");
  });
});

describe("the saving is honest or it is absent", () => {
  it("is the gap between the shop's opening price and what is paid", () => {
    // PER DAY - which is what `ask` and `pricePerDay` are. This assertion used
    // to read `saved`, back when that field held the daily gap and the Trips
    // hero summed it under "saved across N trips" (see trip-savings.test.ts).
    const { savedPerDay, saved, savedPct } = savingOf({
      ...base,
      best: { pricePerDay: 400, ask: 500, currency: "PHP" },
    });
    expect(savedPerDay).toBe(100);
    expect(savedPct).toBe(20);
    // `base` carries no duration, so there is no trip total to state.
    expect(saved).toBeNull();
  });

  it("...and over the whole rental once the duration is known", () => {
    const { savedPerDay, saved } = savingOf({
      ...base,
      durationDays: 5,
      best: { pricePerDay: 400, ask: 500, currency: "PHP" },
    });
    expect(savedPerDay).toBe(100);
    expect(saved).toBe(500);
  });

  it("a booking's real price beats a live quote", () => {
    const t = toTrip(
      {
        ...base,
        best: { pricePerDay: 500, ask: 700, currency: "PHP" },
        booking: { vendorName: "x", perDay: 450, total: null, currency: "PHP", scheduledAt: null },
      },
      NOW
    );
    expect(t.perDay).toBe(450);
    expect(t.savedPct).toBe(36);
  });

  it("no opening price means NO claimed saving - never an invented one", () => {
    expect(savingOf({ ...base, best: { pricePerDay: 400, ask: null, currency: "PHP" } }).saved).toBeNull();
  });

  it("is never negative", () => {
    expect(savingOf({ ...base, best: { pricePerDay: 600, ask: 500, currency: "PHP" } }).saved).toBeNull();
  });
});

describe("free users get a LOCKED PREVIEW, not an empty tab", () => {
  const trips = [
    toTrip({ ...base, id: "now", isLatest: true, best: { pricePerDay: 400, ask: 500, currency: "PHP" } }, NOW),
    toTrip({ ...base, id: "past", best: { pricePerDay: 300, ask: 450, currency: "PHP" } }, NOW),
  ];

  it("keeps the trip visible and holds back the numbers", () => {
    // An empty tab teaches a traveller the feature does not exist; a visible
    // trip they cannot fully open teaches them what they would get.
    const p = previewTrip(trips[1]);
    expect(p.headline).toBe(trips[1].headline);
    expect(p.outcome).toBe(trips[1].outcome);
    expect(p.perDay).toBeNull();
    expect(p.savedPct).toBeNull();
  });

  it("free keeps the CURRENT hunt in full and locks the history", () => {
    const shown = visibleTrips(trips, false);
    expect(shown).toHaveLength(2); // nothing is hidden
    expect(shown[0].locked).toBe(false);
    expect(shown[0].perDay).toBe(400);
    expect(shown[1].locked).toBe(true);
    expect(shown[1].perDay).toBeNull();
  });

  it("Pro sees every trip in full", () => {
    const shown = visibleTrips(trips, true);
    expect(shown.every((t) => !t.locked)).toBe(true);
    expect(shown[1].perDay).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the trip reaches the tab", () => {
  it("the deals API returns one per hunt, from data it already reads", () => {
    const api = readCode("src/app/api/deals/route.ts");
    expect(api).toMatch(/toTrip\(/);
    expect(api).toMatch(/trip:/);
  });

  it("the tab shows the outcome and locks past trips for free users", () => {
    const page = readCode("src/app/deals/page.tsx");
    expect(page).toMatch(/previewTrip/);
    expect(page).toMatch(/trip\.headline/);
    expect(page).toMatch(/!canHistory && !s\.isLatest/);
  });
});
