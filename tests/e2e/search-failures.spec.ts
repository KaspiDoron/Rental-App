import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededUncontactedWorkspace } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// The repo's signature defect class, browser-reachable at last: a failed
// upstream must produce an HONEST error, never a healthy-looking zero. A
// failed discovery call masquerading as "no shops found near your stay"
// sends travellers widening the radius for nothing.

test.describe("search failure honesty", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("a 500 from discovery renders the failure, never 'no shops found'", async ({ page }) => {
    // A live hunt seeds the ORIGIN (search needs coordinates); the new search
    // then runs against stubbed profile + failing vendors. The UNCONTACTED
    // workspace keeps the funnel idle - a running phase disables the CTA.
    await seedLiveHunt(page, seededUncontactedWorkspace(Date.now()));
    await page.route("**/api/profile", (route) =>
      route.fulfill({
        json: {
          rfq: {
            vehicleClass: "scooter",
            transmission: "automatic",
            durationDays: 2,
            accessories: [],
            fulfillment: "pickup",
          },
        },
      })
    );
    await page.route("**/api/session/close", (route) => route.fulfill({ json: { ok: true } }));
    await page.route("**/api/vendors**", (route) =>
      route.fulfill({ status: 500, json: { error: "Shop discovery is down right now - try again in a minute." } })
    );
    await page.goto("/");
    // With a live hunt the form is collapsed behind the summary bar - expand
    // it first, like a person editing their search would.
    await expect(page.getByRole("button", { name: "Edit your search" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Edit your search" }).click();
    await expect(page.locator('[data-tour="request"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-tour="request"]').fill("125cc scooter for 2 days");
    // The CTA stays disabled until the IDP declaration is ticked.
    await page.getByRole("checkbox", { name: /International Driving Permit/ }).check();
    await page.locator('[data-tour="find"]').click();

    await expect(
      page.getByText("Shop discovery is down right now", { exact: false })
    ).toBeVisible({ timeout: 15_000 });
    // The failure must never masquerade as an honest empty result.
    await expect(page.getByText(/no shops found/i)).toHaveCount(0);
  });
});
