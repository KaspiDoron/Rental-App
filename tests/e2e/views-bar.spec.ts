import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// OWNER REPORT 5: the List/Map/Activity + Feed/Swipe bar was sticky and "blocks
// the whole screen - we need that space". It is now a normal in-flow element.
//
// THE FIRST VERSION OF THIS TEST DID NOT WORK, AND IT IS WORTH SAYING WHY.
// It scrolled 400px from the top and asserted the bar's viewport-top had
// dropped by at least 0.7x that. But the bar sits ~1450px down the document at
// 320px wide, so a 400px scroll never brings it anywhere near its pin point:
// sticky and static both move it exactly 400px. An adversarial pass re-stuck
// the bar with a plain later rule and this spec still passed - delta 400 either
// way - which made it a guard in name only, while its own header claimed to be
// the one thing pinning the BEHAVIOUR in a real browser.
//
// A sticky element only reveals itself once the page has scrolled PAST it. So
// the assertion now scrolls to the very bottom of the document, where an
// in-flow bar is far off the top of the screen and a pinned one is parked just
// under the top bar. Measured today: bottom is -1384 in flow, and +159 when
// deliberately re-stuck.

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
    const startTop = await bar.evaluate((el) => el.getBoundingClientRect().top);

    // All the way down, so the bar is genuinely scrolled past.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);

    const seen = await bar.evaluate((el) => ({
      bottom: el.getBoundingClientRect().bottom,
      position: getComputedStyle(el).position,
    }));
    const scrolled = await page.evaluate(() => window.scrollY);

    // The hunt must actually have room to scroll past the bar, or the assertion
    // below is vacuous again - this is the check whose absence hid the defect.
    expect(
      scrolled,
      "page did not scroll far enough to pass the bar - seed has too little content"
    ).toBeGreaterThan(startTop);

    // THE ASSERTION. Off the top of the viewport entirely, not merely "moved".
    expect(
      seen.bottom,
      `the views bar is pinned below the top bar (position: ${seen.position})`
    ).toBeLessThanOrEqual(0);

    // ...and the mechanism, so a future re-stick fails here with a clear reason
    // rather than only as a mysterious geometry mismatch.
    expect(seen.position, "the views bar must stay in flow").not.toBe("sticky");
    expect(seen.position).not.toBe("fixed");
  });

  test("a jump to the shop list lands the first card BELOW the top bar", async ({ page }) => {
    // The other half of un-sticking: `goToSection` scrolls these anchors into
    // view, and a target with no scroll-margin lands under the still-sticky top
    // bar. The views bar had the margin; the vendors anchor did not, so the
    // first shop card's whole name row was hidden behind the bar.
    await seedLiveHunt(page);
    await page.goto("/");
    const vendors = page.locator('[data-tour="vendors"]');
    await expect(vendors).toBeAttached({ timeout: 20_000 });

    // RETRY, NOT A FIXED NAP. The windowed list keeps re-measuring rows for a
    // while after load, and each estimate->actual delta nudges the page - a
    // 400ms settle was long enough on a fast machine and silently short on a
    // loaded one. Re-run the jump until the geometry it asserts is quiet; the
    // assertion itself (the card lands BELOW the bar) is unchanged.
    await expect(async () => {
      const covered = await page.evaluate(async () => {
        const el = document.querySelector('[data-tour="vendors"]') as HTMLElement | null;
        const bar = document.querySelector(".topbar") as HTMLElement | null;
        if (!el || !bar) return null;
        // Jump from the bottom, which is the direction that buries the target.
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        el.scrollIntoView({ behavior: "auto", block: "start" });
        await new Promise((r) => setTimeout(r, 400));
        return bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      });
      expect(covered, "[data-tour=vendors] is not reachable").not.toBeNull();
      // A couple of px of rounding is fine; a buried card is not.
      expect(covered!, "the shop list landed underneath the top bar").toBeLessThanOrEqual(2);
    }).toPass({ timeout: 20_000 });
  });
});
