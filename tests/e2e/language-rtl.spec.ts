import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededWorkspace } from "./fixtures/seeds";
import { dismissTour, seedLocale, assertNoOverflow } from "./fixtures/init";

// Wave 3.2, the owner's Hebrew screenshots: "elgooG" (the wordmark's
// per-letter flex items reordering under RTL), a summary bar that ate both
// ends of the line, and Hebrew falling to an arbitrary system face. The
// locale is seeded through the app's own localStorage cache - deterministic,
// offline, no LLM.

test.describe("Hebrew / RTL @rtl", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
    await seedLocale(context, "he", {
      Trips: "טיולים",
      "Find deals": "מציאות",
      Profile: "פרופיל",
      Feedback: "משוב",
    });
  });

  test("RTL document, LTR wordmark, both summary ends, Hebrew brand font", async ({ page }) => {
    // source: "google" renders the attribution banner that carries the
    // wordmark - the exact surface of the "elgooG" screenshot.
    await seedLiveHunt(page, { ...seededWorkspace(Date.now()), source: "google" });
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });

    // The document is RTL and the seeded dictionary actually renders.
    expect(await page.evaluate(() => document.documentElement.getAttribute("dir"))).toBe("rtl");
    await expect(page.getByRole("button", { name: "טיולים" })).toBeVisible();

    // The wordmark is an LTR island: its letters read G-o-o-g-l-e visually
    // even under an RTL document. Measured, not assumed.
    const wordmark = page.locator('[aria-label="Google"]').first();
    await wordmark.scrollIntoViewIfNeeded();
    await expect(wordmark).toBeVisible();
    expect(await wordmark.getAttribute("dir")).toBe("ltr");
    const readsForward = await wordmark.evaluate((el) => {
      const spans = Array.from(el.querySelectorAll("span"));
      const xs = spans.map((s) => s.getBoundingClientRect().left);
      return xs.every((x, i) => i === 0 || x > xs[i - 1]);
    });
    expect(readsForward, "wordmark letters render right-to-left - the elgooG bug").toBe(true);

    // The summary bar keeps BOTH ends: the free-text head and the radius
    // tail. Before 3.2 a JS head-slice stacked on CSS end-truncation ate one
    // end or the other under RTL.
    const summary = page.getByRole("button", { name: "Edit your search" });
    await expect(summary.getByText("scooter for 3 days")).toBeVisible();
    await expect(summary.getByText("5 km", { exact: false })).toBeVisible();

    // Hebrew glyphs draw from the Rubik brand font, not a system fallback.
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont).toMatch(/Rubik/i);

    await assertNoOverflow(page, "RTL workspace");
  });
});
