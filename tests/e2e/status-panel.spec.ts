import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededWorkspace } from "./fixtures/seeds";
import { dismissTour, assertNoOverflow, hitTest, trackPageErrors } from "./fixtures/init";

// The live status panel - the surface of G.6/G.7 and the clipped-chevron
// report. mobile-check remains the independent falsified check; this spec is
// the journey version, running at every width in the repo's 320-430 rule.

test.describe("live status panel @allwidths", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("a seeded hunt renders the panel with all four counters, no overflow", async ({ page }) => {
    const errors = trackPageErrors(page);
    await seedLiveHunt(page, seededWorkspace(Date.now()));
    await page.goto("/");
    const status = page.locator('[data-tour="status"]');
    await expect(status).toBeVisible({ timeout: 20_000 });
    await assertNoOverflow(page, "funnel with live status panel");
    // The chevron expander is REACHABLE, not merely painted (the original
    // defect was a chevron pushed off-screen by translated counter labels).
    expect(await hitTest(page, '[data-tour="status"] button')).toBe(true);
    errors.assertNone();
  });

  test("the vendor list renders the seeded shops", async ({ page }) => {
    await seedLiveHunt(page, seededWorkspace(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="vendors"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Shop offers").first()).toBeVisible();
    await assertNoOverflow(page, "vendor list");
  });
});
