import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// OWNER REPORT 5: the List/Map/Activity + Feed/Swipe bar was sticky and "blocks
// the whole screen - we need that space". It is now a normal in-flow element.
// The unit tests pin the CSS/hook; this pins the BEHAVIOUR in a real browser,
// which nothing did before: after scrolling the page, the bar must travel up
// with the content rather than staying pinned below the top bar.

test.describe("the views bar is not sticky @allwidths", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("it scrolls away with the page instead of pinning below the top bar", async ({ page }) => {
    await seedLiveHunt(page);
    await page.goto("/");
    const bar = page.locator('[data-tour="views"]');
    await expect(bar).toBeAttached({ timeout: 20_000 });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    const before = await bar.evaluate((el) => el.getBoundingClientRect().top);

    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(120);
    const scrolled = await page.evaluate(() => window.scrollY);
    const after = await bar.evaluate((el) => el.getBoundingClientRect().top);

    // The hunt must actually have room to scroll, or the assertion is vacuous.
    expect(scrolled, "page did not scroll - seed has too little content").toBeGreaterThan(50);
    // In flow: the bar's viewport-top drops by ~the scroll amount. Pinned: it
    // would barely move. 0.7x leaves slack for the top bar's own collapse.
    expect(before - after, "the views bar stayed pinned instead of scrolling off").toBeGreaterThan(
      scrolled * 0.7
    );
  });
});
