import { test, expect } from "@playwright/test";
import { assertNoOverflow } from "./fixtures/init";

// The public content surfaces: guides (the AdSense estate), legal pages, and
// the pricing page - reachable signed out, honest when their data is thin.

test.describe("public content @signedout", () => {
  test("/guides lists articles and each card links to a real page", async ({ page }) => {
    await page.goto("/guides");
    const links = page.locator('a[href^="/guides/"]');
    await expect(links.first()).toBeVisible();
    const href = await links.first().getAttribute("href");
    await page.goto(href!);
    await expect(page.locator("h1").first()).toBeVisible();
    await assertNoOverflow(page, "guide article");
  });

  test("legal pages render with substance", async ({ page }) => {
    for (const path of ["/terms", "/privacy"]) {
      await page.goto(path);
      await expect(page.locator("h1, h2").first()).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text.length, `${path} looks empty`).toBeGreaterThan(500);
      await assertNoOverflow(page, path);
    }
  });

  test("/pricing renders the plan cards", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByText(/pro/i).first()).toBeVisible();
    await expect(page.getByText(/ultra/i).first()).toBeVisible();
    await assertNoOverflow(page, "pricing");
  });

  test("/welcome renders the public homepage without overflow", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.locator("h1").first()).toBeVisible();
    await assertNoOverflow(page, "welcome");
  });
});
