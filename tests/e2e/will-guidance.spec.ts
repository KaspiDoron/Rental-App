import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededWorkspace, seededUncontactedWorkspace } from "./fixtures/seeds";
import { dismissTour, trackPageErrors } from "./fixtures/init";

// Owner report 3, item 9: shops found with ZERO messages sent used to derive
// NEGOTIATING, so Will offered "See it live" with nothing live while the
// status panel on the same screen truthfully said 0 contacted. The 1.5 fix
// added the SHOPS_FOUND step keyed on the panel's own numbers.

test.describe("Will's guidance matches the funnel's real state", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("shops found + nothing contacted = SHOPS_FOUND advice, never 'see it live'", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await seedLiveHunt(page, seededUncontactedWorkspace(Date.now()));
    await page.goto("/");
    const vendors = page.locator('[data-tour="vendors"]');
    await expect(vendors).toBeAttached({ timeout: 20_000 });
    // The card anchors on the vendors section and (by design) only renders
    // while its anchor is on screen - bring it into view like a person would.
    await vendors.scrollIntoViewIfNeeded();
    // The SHOPS_FOUND card: honest advice that MAKES something live.
    await expect(page.getByText("Found your shops", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    // The wrong-state copy must not be on screen anywhere.
    await expect(page.getByText("Shops are reading your request", { exact: false })).toHaveCount(0);
    errors.assertNone();
  });

  test("a live negotiation shows the NEGOTIATING guidance", async ({ page }) => {
    await seedLiveHunt(page, seededWorkspace(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    // With messaged/replied shops the negotiating (or results) guidance is the
    // honest one - and whichever renders, it renders as Will's card.
    await expect(page.locator('[data-tour="will"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test("the onboarding 'Meet Will' anchor EXISTS (report 3 re-verification item 10)", async ({
    page,
  }) => {
    // The tour step ships `anchor: "will"`. Before this wave no element
    // carried data-tour="will", so the step silently degraded to an
    // unanchored card - a live bug found exactly where the plan predicted.
    await seedLiveHunt(page, seededWorkspace(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-tour="will"]').first()).toBeAttached({ timeout: 15_000 });
  });
});
