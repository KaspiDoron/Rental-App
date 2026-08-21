import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt, seededWorkspace } from "./fixtures/seeds";
import { dismissTour, trackPageErrors } from "./fixtures/init";

// THE JUMP THAT LANDED ~1200px PAST THE SHOP.
//
// Every "take me to this shop" control in the app - Will's guidance, the live
// status panel's per-shop rows, a push deep-link - funnels into
// `scrollToVendor`, which asks the windowed list to bring a row into view
// (VirtualVendorList's scrollRequest -> `virtualizer.scrollToIndex`).
//
// The list estimates every card at ESTIMATE_PX and then MEASURES it. A real
// card is much taller than the estimate, and @tanstack/react-virtual's default
// `shouldAdjustScrollPositionOnItemSizeChange` re-scrolls the SCROLL ELEMENT by
// the estimate->actual delta of every row that looks like it sits above the
// fold. For a window virtualizer that scroll element is the PAGE: jump to row
// ~15 and a dozen first-measurements each shove the window down by their own
// delta, so the traveller is deposited a full screen or more BELOW the shop
// they asked for, with no card of theirs anywhere on screen.
//
// jsdom cannot see any of this - it has no layout, so no measurement, so no
// adjustment. This is the honest layer for it: real Chromium, real CSS, the
// production build, at the repo's phone widths.
//
// FALSIFIED: with the fix reverted (drop the
// `shouldAdjustScrollPositionOnItemSizeChange` assignment in
// VirtualVendorList) this spec reports the card hundreds of pixels off-screen.

/** A hunt big enough that a deep row is far past the estimate's reach. */
function bigHunt(now: number, count = 20) {
  const base = seededWorkspace(now);
  const template = base.vendors[3]; // the one carrying an offer
  return {
    ...base,
    vendors: Array.from({ length: count }, (_, i) => ({
      ...template,
      id: `sh${String(i).padStart(2, "0")}`,
      name: `Rental Shop ${i}`,
      whatsapp: `+66123450${String(i).padStart(2, "0")}`,
      lastInboundAt: new Date(now - 30_000).toISOString(),
      lastInboundText: "Yes we have Click 125 available",
      offer: {
        pricePerDay: 200 + i * 10,
        listPricePerDay: 400,
        currency: "THB",
        round: 1,
        vendorId: `sh${String(i).padStart(2, "0")}`,
        verified: false,
        message: "Click 125 available",
        totalPrice: (200 + i * 10) * 3,
        includesInsurance: false,
        includesDelivery: false,
        simulated: true,
      },
    })),
  };
}

/**
 * Open the live status panel, surviving the hydration race. The expander is a
 * React onClick on a ~5000-line page: a click that lands after paint but
 * before hydration is silently swallowed (the DOM button exists, the handler
 * does not), and on a slow machine that turned this spec red end-to-end. Click
 * until the panel's own content proves the handler ran - the ASSERTIONS this
 * file exists for (the jump lands ON the shop) are untouched.
 */
async function openStatusPanel(page: Page): Promise<void> {
  const expander = page.locator('[data-tour="status"] > button').first();
  await expect(async () => {
    await expander.click();
    await expect(
      page.locator('[data-tour="status"] button:has-text("Rental Shop")').first()
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Wait until the page has stopped scrolling (smooth scroll + measurement). */
async function scrollSettled(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = window.scrollY;
        let stable = 0;
        const started = Date.now();
        const tick = () => {
          const y = window.scrollY;
          stable = y === last ? stable + 1 : 0;
          last = y;
          // ~10 quiet frames, or give up after 6s and report where we are.
          if (stable >= 10 || Date.now() - started > 6000) resolve(y);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
}

/** How far the card is from the viewport, in px. 0 = at least partly on screen. */
async function offScreenBy(page: Page, vendorId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.getElementById(`vendor-${id}`);
    if (!el) return Number.NaN;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0) return -r.bottom; // scrolled PAST it
    if (r.top > window.innerHeight) return r.top - window.innerHeight; // stopped short
    return 0;
  }, vendorId);
}

test.describe("a jump to a shop lands ON the shop @allwidths", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    await signIn(context);
  });

  test("the status panel's per-shop jump puts that card on screen", async ({ page }) => {
    const errors = trackPageErrors(page);
    await seedLiveHunt(page, bigHunt(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });

    // Open the live status panel and use its own "jump to this shop" control -
    // the surface that triggers most jumps in the product.
    await openStatusPanel(page);
    const target = "sh15";
    const row = page.locator(`[data-tour="status"] button:has-text("Rental Shop 15")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    await scrollSettled(page);
    const missedBy = await offScreenBy(page, target);
    expect(
      missedBy,
      `the jump left "Rental Shop 15" ${Math.round(missedBy)}px outside the viewport`
    ).toBeLessThan(1);
    errors.assertNone();
  });

  test("...and a jump to a DEEP row does not drag the page past it either", async ({ page }) => {
    await seedLiveHunt(page, bigHunt(Date.now()));
    await page.goto("/");
    await expect(page.locator('[data-tour="status"]')).toBeVisible({ timeout: 20_000 });
    await openStatusPanel(page);
    const row = page.locator(`[data-tour="status"] button:has-text("Rental Shop 19")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await scrollSettled(page);
    expect(await offScreenBy(page, "sh19")).toBeLessThan(1);
  });
});
