import { test, expect } from "@playwright/test";
import { signIn, asPlan } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// Three Trips journeys: (a) a FREE traveller meets the Pro/Ultra gate as real
// upgrade tier cards that say so, and the CTA opens the existing upgrade sheet;
// (b) a paid traveller can actually re-open an earlier hunt; (c) a live hunt
// SURVIVES tab navigation - wd_search rides sessionStorage across the
// client-routed hop (Wave 2.3) instead of dying with a full document load.
//
// W6.1 replaced the old "locked preview" - every hunt visible with its numbers
// redacted in the BROWSER, plus a per-row "Re-open this hunt (Pro)" button -
// because the owner asked for tier cards and because redacting in the browser
// shipped the whole history to a free plan anyway.

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

test.describe("trips re-open", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("free plan: Trips is the tier cards, and they open the upgrade sheet", async ({
    page,
  }) => {
    await asPlan(page, "free");
    // What the SERVER answers a free plan: no hunts, just how many are saved.
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({
        json: { locked: true, feature: "trips-history", huntCount: 3, sessions: [], bookings: [] },
      })
    );
    await page.goto("/deals");
    // The gate is WRITTEN DOWN, as the owner asked - not implied by a blur.
    await expect(page.getByText("Trips is a Pro & Ultra feature")).toBeVisible();
    await expect(page.getByText(/3 saved hunts are waiting/)).toBeVisible();
    // Real tier cards from the shared plan catalogue.
    await expect(page.getByText("Pro Traveller")).toBeVisible();
    await expect(page.getByText("Ultra", { exact: true })).toBeVisible();
    // ...and the CTA is the EXISTING sheet, not a second checkout surface.
    await page.getByRole("button", { name: "See plans & upgrade" }).first().click();
    await expect(page.getByText("Go Pro or Ultra")).toBeVisible();
  });

  test("paid plan: an earlier hunt can actually be re-opened", async ({ page }) => {
    await asPlan(page, "pro");
    const now = Date.now();
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({
        json: {
          sessions: [
            session({ id: "9", sid: 9, isLatest: true, query: "fresh hunt" }),
            session({
              id: "3",
              sid: 3,
              query: "yesterday's hunt",
              // 2h old: still in the ACTIVE section, but not the latest.
              startedAt: new Date(now - 2 * 3600_000).toISOString(),
            }),
          ],
          bookings: [],
        },
      })
    );
    await page.goto("/deals");
    await expect(page.getByText("yesterday's hunt")).toBeVisible();
    await page.getByRole("button", { name: /yesterday's hunt/ }).click();
    await expect(page.getByRole("button", { name: "Re-open this hunt" })).toBeVisible();
    // No per-row Pro lock survives - the gate is met once, up front.
    await expect(page.getByText("Re-open this hunt (Pro)")).toHaveCount(0);
  });

  test("a live hunt survives Trips-and-back (client nav keeps wd_search)", async ({ page }) => {
    await seedLiveHunt(page);
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({ json: { sessions: [], bookings: [] } })
    );
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Trips" }).click();
    await page.waitForURL("**/deals");
    await page.getByRole("button", { name: "Find deals" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    // The workspace is back without a fresh restore round-trip: wd_search
    // (sessionStorage) survived because the hop never unloaded the document.
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
  });
});
