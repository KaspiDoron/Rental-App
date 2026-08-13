import { expect, type BrowserContext, type Page } from "@playwright/test";

// First-visit init + the layout pokers, shared by every journey.

/** Dismiss the first-run onboarding overlay before it can eat taps. */
export async function dismissTour(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("wd_onboarded", "1");
    } catch {
      /* private mode */
    }
  });
}

/**
 * Seed a locale through the app's own localStorage cache (wd_lang +
 * wd_i18n_<lang>, src/lib/i18n.tsx) so language behaviour is deterministic
 * and offline - never a live LLM call.
 */
export async function seedLocale(
  context: BrowserContext,
  lang: string,
  dict: Record<string, string>
): Promise<void> {
  await context.addInitScript(
    ({ l, d }) => {
      try {
        localStorage.setItem("wd_lang", l);
        localStorage.setItem(`wd_i18n_${l}`, JSON.stringify(d));
      } catch {
        /* private mode */
      }
    },
    { l: lang, d: dict }
  );
}

/**
 * THE MOBILE RULE, MEASURED (mobile-check's poker verbatim): the page body
 * never scrolls horizontally, and no element's right edge passes the
 * viewport. Wide content must be its own overflow-x scroller.
 */
export async function assertNoOverflow(page: Page, label = "page"): Promise<void> {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const doc = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    let worst: { desc: string; right: number } | null = null;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // An element inside a horizontal scroller is ALLOWED past the edge -
      // that is what the scroller is for. So is one inside an overflow-hidden
      // ancestor (clipped decoration, e.g. the Trips savings-card blob): it
      // cannot widen the page, and the scrollWidth assertion above this loop
      // still catches anything that actually does.
      let p: HTMLElement | null = el.parentElement;
      let contained = false;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") {
          contained = true;
          break;
        }
        p = p.parentElement;
      }
      if (contained) continue;
      if (rect.right > vw + 1 && (!worst || rect.right > worst.right)) {
        const cls = (el.className && String(el.className).slice(0, 60)) || el.tagName.toLowerCase();
        worst = { desc: cls, right: Math.round(rect.right) };
      }
    }
    return { vw, doc, worst };
  });
  expect(r.doc, `${label}: document scrollWidth ${r.doc} > viewport ${r.vw}`).toBeLessThanOrEqual(
    r.vw + 1
  );
  expect(
    r.worst,
    `${label}: ${r.worst?.desc ?? ""} extends to ${r.worst?.right ?? 0} past the viewport`
  ).toBeNull();
}

/**
 * "Visible" and "REACHABLE" are different questions. This asks the second
 * one: does a tap at the element's centre actually land on it (or inside it)?
 */
export async function hitTest(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  }, selector);
}

/** Collect uncaught page errors; assert none at the end of a journey. */
export function trackPageErrors(page: Page): { assertNone: () => void } {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  return {
    assertNone: () => expect(errors, `uncaught page errors: ${errors[0] ?? ""}`).toEqual([]),
  };
}
