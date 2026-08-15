import { test, expect } from "@playwright/test";
import { signIn, asPlan } from "./fixtures/session";
import { dismissTour, assertNoOverflow } from "./fixtures/init";

// Trips (owner report 3, items 1.1/1.2): the list once rendered the OLDEST
// five hunts as the newest (a double reverse), and a cleared hunt still
// offered a live Re-open that could only 404.
//
// W6.1: Trips is a Pro/Ultra section, so every spec here declares the plan it
// is describing (`asPlan`). The free-plan journey is its own spec in
// trips-reopen.spec.ts - a free traveller sees upgrade tier cards, not a list.

// Mirrors /api/deals's SessionSummary (route.ts) - a wrong shape here does
// not fail the fetch, it crashes the renderer into the error boundary.
function session(over: Record<string, unknown>) {
  return {
    id: "1",
    startedAt: new Date().toISOString(),
    sid: 1,
    isLatest: false,
    query: "scooter in patong",
    vehicleClass: "scooter",
    radiusKm: 5,
    shopsFound: 6,
    status: "waiting",
    paused: false,
    closed: false,
    contacted: 3,
    replied: 1,
    waiting: 2,
    offers: [],
    best: null,
    avgAsk: null,
    booking: null,
    attention: [],
    plannedMoves: [],
    queuedSends: 0,
    timeline: [],
    progress: 40,
    progressLabel: "Shops are answering",
    ...over,
  };
}

test.describe("trips list", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("newest hunt renders FIRST and carries the live badge, not the oldest", async ({
    page,
  }) => {
    await asPlan(page, "pro");
    const now = Date.now();
    // The page fetches exactly "/api/deals" (no query string) - a "?**" glob
    // never matches and the page falls through to the real (empty) API.
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({
        json: {
          sessions: [
            session({
              id: "9",
              sid: 9,
              isLatest: true,
              query: "NEWEST scooter hunt",
              startedAt: new Date(now - 60_000).toISOString(),
            }),
            session({
              id: "3",
              sid: 3,
              query: "OLDER motorbike hunt",
              startedAt: new Date(now - 26 * 3600_000).toISOString(),
            }),
          ],
          bookings: [],
        },
      })
    );
    await page.goto("/deals");
    const newest = page.getByText("NEWEST scooter hunt");
    await expect(newest).toBeVisible();
    // The >24h-old hunt lives in the collapsed "Earlier hunts" archive
    // (W-2b active/archive split) - open it like a person would.
    await page.getByRole("button", { name: /Earlier hunts/ }).click();
    const older = page.getByText("OLDER motorbike hunt");
    await expect(older).toBeVisible();
    // Newest-first: the fresh hunt's card renders ABOVE the older one. Before
    // the 1.1 fix the list double-reversed and the oldest led with the badge.
    const newestBox = await newest.boundingBox();
    const olderBox = await older.boundingBox();
    expect(newestBox!.y).toBeLessThan(olderBox!.y);
    await assertNoOverflow(page, "trips list");
  });

  test("a CLOSED hunt says so honestly and offers no live Re-open", async ({ page }) => {
    await asPlan(page, "pro");
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({
        json: {
          sessions: [
            session({ id: "9", sid: 9, isLatest: true, query: "live hunt" }),
            session({ id: "4", sid: 4, query: "cleared hunt", closed: true }),
          ],
          bookings: [],
        },
      })
    );
    await page.goto("/deals");
    await expect(page.getByText("cleared hunt")).toBeVisible();
    // Only the newest card opens expanded - the actions area (where the
    // honest closed-state copy lives) needs the card tapped open first.
    await page.getByRole("button", { name: /cleared hunt/ }).click();
    await expect(
      page.getByText("You cleared this hunt - it stays here as history.")
    ).toBeVisible();
    // The closed card must not offer a Re-open that can only 404 - and the
    // only non-latest hunt IS the closed one, so no Re-open belongs anywhere.
    await expect(page.getByText(/Re-open/)).toHaveCount(0);
  });

  test("a 500 renders an honest failure, never an empty 'no trips yet'", async ({ page }) => {
    await asPlan(page, "pro");
    await page.route("**/api/deals**", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await page.goto("/deals");
    await expect(page.getByText("Couldn't load your trips")).toBeVisible();
  });
});
