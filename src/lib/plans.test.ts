import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PLANS, planById, planPriceIls, PLAN_CURRENCY } from "./plans";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THERE WERE TWO PRICES AND THE SHARED ONE WAS WRONG.
//
// plans.ts computed Pro 5.40 / Ultra 29.40 - a list price times an 80%
// `LAUNCH_DISCOUNT`. UpgradeSheet.tsx hardcoded 16.50 / 88 in its own ILS map,
// under a comment asserting those "match the PayPal billing plans exactly".
// The hardcoded pair was the truth. So the module every other consumer imported
// under-reported the real charge by roughly 3x, and the only surface that had it
// right was the one that had opted out of the shared source.
//
// The discount is now gone outright - not re-tuned. It was cancelled so that
// access could be GATED instead of discounted (src/lib/warmup.ts): a gate on a
// discounted price is incoherent, and a discount pays people to tolerate a
// warm-up rather than making them want to finish it.

describe("one price, and it is the one PayPal charges", () => {
  it("Pro and Ultra carry the real quarterly charge", () => {
    expect(planPriceIls("pro")).toBe(16.5);
    expect(planPriceIls("ultra")).toBe(88);
  });

  it("free is genuinely free", () => {
    expect(planPriceIls("free")).toBe(0);
  });

  it("amounts are minor units, so no consumer has to guess the scale", () => {
    expect(planById("pro").amount).toBe(1650);
    expect(planById("ultra").amount).toBe(8800);
    expect(PLAN_CURRENCY).toBe("ILS");
  });

  it("an unknown plan id falls back to free, never to a paid tier", () => {
    // Fail-safe direction matters: an unrecognised id must never hand someone a
    // paid entitlement, and must never bill them either.
    expect(planById("nonsense").id).toBe("free");
    expect(planById(undefined).id).toBe("free");
  });
});

describe("REGRESSION: the discount is gone from the code, not just from the copy", () => {
  const plans = readCode("src/lib/plans.ts");
  const sheet = readCode("src/components/UpgradeSheet.tsx");

  it("no discount arithmetic survives in the catalogue", () => {
    expect(plans).not.toMatch(/LAUNCH_DISCOUNT/);
    expect(plans).not.toMatch(/listAmount/);
    expect(plans).not.toMatch(/discountPct/);
  });

  it("the Plan type no longer carries a list price to render", () => {
    // A `listAmount` field is what a struck-through price is drawn from. While
    // the field exists someone will render it again.
    for (const p of PLANS) {
      expect(p).not.toHaveProperty("listAmount");
      expect(p).not.toHaveProperty("discountPct");
    }
  });

  it("the upgrade sheet no longer keeps its own price map", () => {
    expect(sheet).not.toMatch(/ILS_PRICES/);
    // ...and it reads the catalogue amount instead.
    expect(sheet).toMatch(/planPrice\(plan\.amount, currencyCode\)/);
  });

  it("no struck-through list price is rendered anywhere in the sheet", () => {
    expect(sheet).not.toMatch(/line-through/);
  });
});

describe("REGRESSION: no user-facing surface still advertises a launch discount", () => {
  // The discount appeared in five places that had no reason to know about each
  // other - the sheet, the login welcome, the social card, the pricing page
  // metadata and the translation catalogue. Removing four of five would leave
  // the product promising a price it does not charge.
  const surfaces = [
    "src/components/UpgradeSheet.tsx",
    "src/app/login/page.tsx",
    "src/app/opengraph-image.tsx",
    "src/app/pricing/page.tsx",
    "src/lib/i18n-catalog.ts",
  ];

  for (const path of surfaces) {
    it(`${path} makes no discount claim`, () => {
      const code = readCode(path);
      expect(code, `${path} still advertises a discount`).not.toMatch(
        /80%\s*off|launch pricing|opening offer|% off/i
      );
    });
  }
});
