import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededUncontactedWorkspace } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// Wave 2.2: the whole-screen ambient wash. It shipped once before as dead
// CSS (mounted nowhere, its test grepped the stylesheet); these journeys
// prove the LIVE tree - the layer is permanently mounted, rises with a
// search dispatch, and falls when the wait ends.

async function startSlowSearch(page: import("@playwright/test").Page) {
  await page.route("**/api/profile", async (route) => {
    await new Promise((r) => setTimeout(r, 2_500));
    await route.fulfill({
      json: {
        rfq: {
          vehicleClass: "scooter",
          transmission: "automatic",
          durationDays: 2,
          accessories: [],
          fulfillment: "pickup",
        },
      },
    });
  });
  await page.route("**/api/session/close", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/vendors**", (route) =>
    route.fulfill({ status: 500, json: { error: "Shop discovery is down right now." } })
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Edit your search" }).click();
  await page.locator('[data-tour="request"]').fill("125cc scooter for 2 days");
  await page.getByRole("checkbox", { name: /International Driving Permit/ }).check();
  await page.locator('[data-tour="find"]').click();
}

test.describe("ambient loading wash", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("the ambient layer is MOUNTED, rises on search dispatch, and falls after", async ({
    page,
  }) => {
    await seedLiveHunt(page, seededUncontactedWorkspace(Date.now()));
    await startSlowSearch(page);
    // Mounted permanently (the dead-CSS failure mode), ON while the wait is
    // real, OFF once the funnel resolves (here: the discovery failure).
    const ambient = page.locator(".wd-ambient");
    await expect(ambient).toHaveCount(1);
    await expect(ambient).toHaveClass(/wd-ambient-on/, { timeout: 5_000 });
    await expect(page.getByText("Shop discovery is down right now")).toBeVisible({
      timeout: 15_000,
    });
    await expect(ambient).not.toHaveClass(/wd-ambient-on/, { timeout: 10_000 });
  });

  test("reduced motion: the wash holds still @reduced", async ({ page }) => {
    await seedLiveHunt(page, seededUncontactedWorkspace(Date.now()));
    await startSlowSearch(page);
    const ambient = page.locator(".wd-ambient");
    await expect(ambient).toHaveClass(/wd-ambient-on/, { timeout: 5_000 });
    // prefers-reduced-motion: the breathe animation is disabled in CSS.
    const animation = await ambient.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });
});
