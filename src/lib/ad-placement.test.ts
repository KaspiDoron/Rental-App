import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const page = stripComments(readRaw("src/app/page.tsx"));
const banner = stripComments(readRaw("src/components/AdBanner.tsx"));

// M13: BANNERS AWAY FROM PRIMARY ACTIONS.
//
// The funnel had an ad slot sitting between the best-price "Lock it" button and
// the Ultra language toggle - an ad touching the single highest-value tap in
// the product. That invites a misclick on the one action that closes a deal,
// and it interrupts the exact moment the app exists to produce.
//
// It was also a duplicate: it rendered on `vendors.length > 0` while the
// in-feed slot renders on `vendors.length > 3 && view === "list"`, so a free
// user with four shops in list view got two ad units on one screen.

describe("the funnel carries one ad slot, not two", () => {
  it("exactly one AdBanner is mounted on the main page", () => {
    expect((page.match(/<AdBanner /g) ?? []).length).toBe(1);
  });

  it("the surviving slot is the in-feed one", () => {
    expect(page).toMatch(
      /\{vendors\.length > 3 && view === "list" && <AdBanner plan=\{session\?\.plan\} \/>\}/
    );
  });

  it("the slot beside the Lock it CTA is gone", () => {
    // The removed condition. If it ever comes back, so does the misclick.
    expect(page).not.toMatch(/\{vendors\.length > 0 && <AdBanner/);
  });

  it("no ad sits between the best-price CTA and the language toggle", () => {
    const lockIt = page.indexOf('{t("Lock it")}');
    const nextAd = page.indexOf("<AdBanner ", lockIt);
    const languageToggle = page.indexOf("languageLocked", lockIt);
    expect(lockIt).toBeGreaterThan(-1);
    expect(languageToggle).toBeGreaterThan(lockIt);
    // Either there is no ad after the CTA at all, or it comes well after the
    // action cluster - never wedged inside it.
    expect(nextAd === -1 || nextAd > languageToggle).toBe(true);
  });
});

describe("ads are a free-tier surface only", () => {
  it("the banner renders nothing for a paid plan", () => {
    // Paid plans are advertised as ad-free; this is the code that has to honour
    // that, and it is the entitlement the no-ads perk sells.
    expect(banner).toMatch(/const free = !plan \|\| plan === "free"/);
    expect(banner).toMatch(/if \(!free\) return/);
  });

  it("the unit id comes from the vault, not a hardcoded constant", () => {
    // So an ad unit can be changed without a redeploy.
    expect(banner).toMatch(/adsenseClient/);
    expect(banner).toMatch(/adsenseSlot/);
  });
});

describe("the empty first screen stays ad-free", () => {
  it("B10 still holds", () => {
    // A "Sponsored" box is the wrong first impression before a single search
    // has run. The surviving slot needs 4+ vendors, so this is now structural
    // rather than a condition someone has to remember.
    expect(page).toMatch(/vendors\.length > 3 && view === "list" && <AdBanner/);
  });
});
