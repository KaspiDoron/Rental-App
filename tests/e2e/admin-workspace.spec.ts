import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { dismissTour } from "./fixtures/init";

// Wave 3.5: the management workspace's fail-dark contract, in a real browser.
// The owner's screenshot was a Command tab frozen on its skeleton because ONE
// fetch failed inside a Promise.all; the repaired tab must degrade honestly
// (dash-not-zero + the DegradedBanner) and a failed leg must become an error
// card with a Retry, never a permanent skeleton.

test.describe("management workspace", () => {
  test("a non-management session is told so - no tabs, no data", async ({ context, page }) => {
    await dismissTour(context);
    await signIn(context, "traveller@e2e.test");
    await page.goto("/admin");
    await expect(page.getByText("This workspace is restricted to management.")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Command renders DARK figures honestly (dash + banner, never a confident zero)", async ({
    context,
    page,
  }) => {
    await dismissTour(context);
    await signIn(context, "admin@e2e.test");
    // NOTE: an UNCONFIGURED Supabase is a real zero by design (demo mode), so
    // the degraded state is driven through the route's own contract: null
    // stats + their names in degraded[] - what /api/admin/command returns
    // during an outage (pinned server-side in admin-workspace.test.ts).
    await page.route("**/api/admin/command", (route) =>
      route.fulfill({
        json: {
          alerts: [],
          degraded: ["shop replies", "offers"],
          stats: {
            waSessions: 3,
            repliesToday: null,
            offersToday: null,
            queuedMessages: 0,
            openFeedback: 0,
          },
        },
      })
    );
    await page.goto("/admin");
    await expect(page.getByText("Some figures could not be read", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("shop replies, offers", { exact: false })).toBeVisible();
    await expect(page.getByText("is unknown, not zero", { exact: false })).toBeVisible();
    // The dash-not-zero contract on the tiles themselves.
    await expect(page.getByText("—").first()).toBeVisible();
    // 3.5 tab surgery: the dead graph-era "agents" tab is gone, "settings"
    // (theme + language) exists.
    const nav = page.locator(".surface-strong").first();
    await expect(nav.getByRole("button", { name: /settings/i })).toBeVisible();
    await expect(nav.getByRole("button", { name: /agents/i })).toHaveCount(0);
  });

  test("a failed Command leg is an error card with Retry - and Retry recovers", async ({
    context,
    page,
  }) => {
    await dismissTour(context);
    await signIn(context, "admin@e2e.test");
    await page.route("**/api/admin/command", (route) =>
      route.fulfill({ status: 500, body: "upstream exploded" })
    );
    await page.goto("/admin");
    await expect(page.getByText("Could not load:", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("command overview", { exact: false })).toBeVisible();
    const retry = page.getByRole("button", { name: /Retry/ });
    await expect(retry).toBeVisible();
    // The upstream comes back; Retry must actually recover the section.
    await page.unroute("**/api/admin/command");
    await retry.click();
    await expect(page.getByText("Could not load:", { exact: false })).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});
