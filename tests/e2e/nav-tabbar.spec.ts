import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour, hitTest } from "./fixtures/init";

// Wave 2.3: TabBar taps are CLIENT navigations (router.push), not full
// document loads. The proof is a window property: a full navigation would
// wipe it, client routing keeps it.

test.describe("tab bar navigation", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("a tab hop is a client navigation - window state survives", async ({ page }) => {
    await seedLiveHunt(page);
    // Exact-pathname match: a "**/api/deals**" glob would ALSO swallow
    // /api/deals/restore and starve the seeded hunt.
    await page.route((url) => url.pathname === "/api/deals", (route) =>
      route.fulfill({ json: { sessions: [], bookings: [] } })
    );
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      (window as unknown as { __navMarker?: number }).__navMarker = 42;
    });
    // Tabs are buttons (router.push on tap), not anchors.
    await page.getByRole("button", { name: "Trips" }).click();
    await page.waitForURL("**/deals");
    const marker = await page.evaluate(
      () => (window as unknown as { __navMarker?: number }).__navMarker
    );
    expect(marker, "a full document navigation wiped window state - tab is not client-routed").toBe(
      42
    );
  });

  test("the tab bar is REACHABLE at the bottom (not mid-screen, nothing on top)", async ({
    page,
  }) => {
    await seedLiveHunt(page);
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    const tripsTab = page.getByRole("button", { name: "Trips" });
    await expect(tripsTab).toBeVisible();
    const box = await tripsTab.boundingBox();
    const viewport = page.viewportSize()!;
    // Anchored in the bottom fifth of the screen - the owner's screenshot had
    // it floating mid-screen after the keyboard closed.
    expect(box!.y).toBeGreaterThan(viewport.height * 0.8);
    expect(await hitTest(page, 'button[aria-label="Trips"]')).toBe(true);
  });
});
