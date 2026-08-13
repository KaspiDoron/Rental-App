import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// Two Trips journeys: (a) the free-plan lock on re-opening an EARLIER hunt
// surfaces the upgrade sheet instead of a dead button; (b) a live hunt
// SURVIVES tab navigation - wd_search rides sessionStorage across the
// client-routed hop (Wave 2.3) instead of dying with a full document load.

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

  test("free plan: an earlier hunt offers the LOCKED re-open and it opens the upgrade sheet", async ({
    page,
  }) => {
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
    const locked = page.getByRole("button", { name: "Re-open this hunt (Pro)" });
    await expect(locked).toBeVisible();
    await locked.click();
    await expect(page.getByText("Go Pro or Ultra")).toBeVisible();
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
