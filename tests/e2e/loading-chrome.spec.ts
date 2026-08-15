import { test, expect } from "@playwright/test";

// THE COLOUR RULE, CHECKED IN A REAL BROWSER.
//
// The owner's instruction was to remove the blue from the loading components
// completely and let the ambient wash behind the app carry every colour. The
// unit suite pins that rule against the STYLESHEET TEXT, which is exactly the
// kind of assertion that keeps passing while the rendered pixels disagree - a
// cascade order, a Tailwind utility, a theme override, or a tree-shaken
// keyframe can all break the rendering without touching the text being
// grepped. (That last one is not hypothetical here: the skeleton shimmer once
// shipped referencing a keyframe Tailwind had shaken away, and every
// text-level pin still passed while every skeleton sat dead on the page.)
//
// So these read COMPUTED STYLE off a live page instead. Set WD_SHOTS=1 to also
// drop screenshots into test-results/ for a human to look at.
const SHOTS = process.env.WD_SHOTS === "1";

/** A colour is neutral when its channels are near-equal. A brand blue is not. */
const NEUTRAL_SPREAD = 18;

test.describe("the loading chrome paints no brand colour @signedout", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`skeleton plate and horizon rail are neutral in ${theme}`, async ({ page }) => {
      await page.goto("/");
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);

      // Render the placeholders in isolation, against the app's real
      // stylesheet, so the material can be measured without a live hunt.
      await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "wd-loading-harness";
        host.style.cssText = "position:fixed;inset:0;z-index:5;padding:16px";
        host.innerHTML = `
          <div class="glass-solid glass-rim rounded-blob p-4">
            <div class="skeleton rounded-xl mb-2 h-4 w-1/3"></div>
            <div class="skeleton rounded-xl mb-3 h-3 w-2/3"></div>
            <div class="skeleton rounded-xl h-3 w-full"></div>
          </div>
          <span class="wd-horizon" style="width:124px;margin-top:14px"></span>`;
        document.body.appendChild(host);
      });
      await page.waitForTimeout(250);

      const seen = await page.evaluate((spread) => {
        const channels = (c: string) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        const neutral = (c: string) => {
          const [r, g, b] = channels(c);
          if ([r, g, b].some((n) => Number.isNaN(n))) return true; // transparent
          return Math.max(r, g, b) - Math.min(r, g, b) <= spread;
        };
        const plate = getComputedStyle(document.querySelector(".skeleton")!).backgroundColor;
        const rail = getComputedStyle(document.querySelector(".wd-horizon")!).backgroundColor;
        const sheen = getComputedStyle(
          document.querySelector(".skeleton")!,
          "::after"
        ).backgroundImage;
        return {
          plate,
          rail,
          sheen,
          plateNeutral: neutral(plate),
          railNeutral: neutral(rail),
          // Every colour stop inside the sweep must be neutral too - the sheen
          // is the one part of a skeleton with a gradient to hide a hue in.
          sheenNeutral: (sheen.match(/rgba?\([^)]+\)/g) || []).every(neutral),
        };
      }, NEUTRAL_SPREAD);

      expect(seen.plateNeutral, `skeleton plate rendered ${seen.plate}`).toBe(true);
      expect(seen.railNeutral, `horizon rail rendered ${seen.rail}`).toBe(true);
      expect(seen.sheenNeutral, `skeleton sheen rendered ${seen.sheen}`).toBe(true);

      if (SHOTS) await page.screenshot({ path: `test-results/loading-${theme}.png` });
    });
  }

  test("the ambient wash behind them IS coloured, and is genuinely raised", async ({ page }) => {
    // The other half of the rule: taking the colour off the chrome is only
    // correct because the page behind it carries more of it than before. An
    // ambient that never actually raises would make this a monochrome app.
    await page.goto("/");
    const amb = await page.evaluate(() => {
      const el = document.querySelector(".wd-ambient");
      if (!el) return null;
      el.classList.add("wd-ambient-on");
      const cs = getComputedStyle(el);
      // COUNT BOTH NOTATIONS. A `color-mix(in oklch, ...)` token serialises as
      // `oklch(...)` in computed style, while a plain hex serialises as
      // `rgb(...)`. Matching only rgb() therefore counts four of the seven
      // lobes and silently under-reports the palette - which is exactly what
      // the first draft of this assertion did. The shared fully-transparent
      // end-stop is excluded so it cannot pad the count.
      const stops = cs.backgroundImage.match(/(?:oklch|rgba?)\([^)]+\)/g) || [];
      return {
        opacity: Number(cs.opacity),
        lobes: (cs.backgroundImage.match(/radial-gradient/g) || []).length,
        colours: new Set(stops.filter((s) => !/,\s*0\)$/.test(s))).size,
      };
    });
    expect(amb, ".wd-ambient is not mounted").not.toBeNull();
    expect(amb!.opacity, "the wash must actually raise").toBeGreaterThan(0.5);
    expect(amb!.lobes, "seven lobes, per the palette").toBe(7);
    expect(amb!.colours, "every lobe must resolve to its own colour").toBe(7);

    if (SHOTS) await page.screenshot({ path: "test-results/ambient.png" });
  });
});
