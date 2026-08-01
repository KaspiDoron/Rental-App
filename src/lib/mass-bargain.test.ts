import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { massBargainTargets, massBargainCap, isMassEligible, MASS_BARGAIN_MAX } from "./mass-bargain";
import type { Vendor } from "./types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const shop = (o: Partial<Vendor> & { id: string }): Vendor =>
  ({
    name: `Shop ${o.id}`,
    rating: 0,
    reviews: 0,
    whatsapp: "66123456789",
    ...o,
  }) as Vendor;

describe("the cap follows the plan, not a constant", () => {
  it("free is held at its own capacity, paid plans reach the owner's ceiling", () => {
    // free allows 10 new contacts per window; pro 30; ultra 40. The run may
    // never exceed 15 in one go, which is the owner's number.
    expect(massBargainCap("free")).toBe(10);
    expect(massBargainCap("pro")).toBe(MASS_BARGAIN_MAX);
    expect(massBargainCap("ultra")).toBe(MASS_BARGAIN_MAX);
    expect(MASS_BARGAIN_MAX).toBe(15);
  });

  it("REPRODUCTION: a Pro traveller is no longer capped at ten", () => {
    const shops = Array.from({ length: 30 }, (_, i) => shop({ id: `v${i}`, rating: 4.5, reviews: 100 }));
    expect(massBargainTargets(shops, "pro").targets.length).toBe(15);
    expect(massBargainTargets(shops, "free").targets.length).toBe(10);
  });
});

describe("eligibility is about whether a conversation already exists", () => {
  it("a shop already quoting or already messaged is left alone", () => {
    expect(isMassEligible(shop({ id: "a", offer: { pricePerDay: 200 } as Vendor["offer"] }))).toBe(false);
    expect(isMassEligible(shop({ id: "b", stage: "rfq-sent" }))).toBe(false);
    expect(isMassEligible(shop({ id: "c", stage: "awaiting-response" }))).toBe(false);
    expect(isMassEligible(shop({ id: "d", stage: "no-contact" }))).toBe(false);
  });

  it("a shop with no way to reach it is not a target", () => {
    expect(isMassEligible(shop({ id: "e", whatsapp: undefined, placeId: undefined }))).toBe(false);
    expect(isMassEligible(shop({ id: "f", whatsapp: undefined, placeId: "place-1" }))).toBe(true);
  });

  it("a fresh, reachable shop is", () => {
    expect(isMassEligible(shop({ id: "g" }))).toBe(true);
  });
});

describe("REPRODUCTION: the run picked whatever the list was sorted by", () => {
  it("it now picks the best-rated, not the first rows", () => {
    // The vendor list is sorted by whatever filter the traveller last touched.
    // On a distance sort, "bargain with the top 10" meant ten shops chosen for
    // being near - including the one-star one with four reviews.
    const shops = [
      shop({ id: "near-bad", rating: 2.1, reviews: 4, distanceKm: 0.2 }),
      shop({ id: "far-great", rating: 4.9, reviews: 800, distanceKm: 9 }),
      shop({ id: "mid", rating: 4.4, reviews: 120, distanceKm: 3 }),
    ];
    const { targets } = massBargainTargets(shops, "free");
    expect(targets.map((v) => v.id)).toEqual(["far-great", "mid", "near-bad"]);
  });

  it("review COUNT breaks a rating tie - three five-star ratings is not evidence", () => {
    const shops = [
      shop({ id: "thin", rating: 5, reviews: 3 }),
      shop({ id: "solid", rating: 5, reviews: 400 }),
    ];
    expect(massBargainTargets(shops, "free").targets[0].id).toBe("solid");
  });

  it("near-identical ratings are treated as equal, and reviews decide", () => {
    // 4.71 vs 4.68 is not a real quality difference; 12 vs 900 reviews is.
    const shops = [
      shop({ id: "slightly-higher", rating: 4.71, reviews: 12 }),
      shop({ id: "well-reviewed", rating: 4.68, reviews: 900 }),
    ];
    expect(massBargainTargets(shops, "free").targets[0].id).toBe("well-reviewed");
  });

  it("all else equal, nearer wins", () => {
    const shops = [
      shop({ id: "far", rating: 4.5, reviews: 100, distanceKm: 8 }),
      shop({ id: "close", rating: 4.5, reviews: 100, distanceKm: 1 }),
    ];
    expect(massBargainTargets(shops, "free").targets[0].id).toBe("close");
  });

  it("the FULL eligible count comes back too, so '15 of 32' can be honest", () => {
    const shops = Array.from({ length: 32 }, (_, i) => shop({ id: `v${i}` }));
    const { targets, eligible } = massBargainTargets(shops, "pro");
    expect(targets.length).toBe(15);
    expect(eligible.length).toBe(32);
  });
});

describe("nothing is sent before the traveller has seen who", () => {
  const page = readCode("src/app/page.tsx");
  const preview = readCode("src/components/MassBargainPreview.tsx");

  it("the button opens the preview; a separate call dispatches", () => {
    expect(page).toMatch(/setMassPreview\(\{ targets, eligibleCount: eligible\.length, cap \}\);/);
    expect(page).toMatch(/const dispatchMassBargain = useCallbackRef\(async \(vendorIds: string\[\]\)/);
    // The old one-tap-to-the-wire path is gone.
    expect(page).not.toMatch(/\.slice\(0, 10\)\s*\n\s*\.map\(\(v\) => \(\{/);
  });

  it("the sheet shows the evidence the ranking used", () => {
    expect(preview).toMatch(/v\.rating\.toFixed\(1\)/);
    expect(preview).toMatch(/\{v\.reviews\}/);
    expect(preview).toMatch(/v\.distanceKm\.toFixed\(1\)/);
    expect(preview).toMatch(/\{v\.address\}/);
    expect(preview).toMatch(/<ShopPhoto/);
  });

  it("...and any shop can be dropped before sending", () => {
    expect(preview).toMatch(/const chosen = targets\.filter\(\(v\) => !dropped\.has\(v\.id\)\);/);
    expect(preview).toMatch(/onConfirm\(chosen\.map\(\(v\) => v\.id\)\)/);
    expect(preview).toMatch(/disabled=\{sending \|\| chosen\.length === 0\}/);
  });

  it("REPRODUCTION: the cap message stops claiming a 10-shop beta limit", () => {
    expect(page).not.toMatch(/10-shop beta limit/);
    expect(page).toMatch(/d\.cap \?\? massBargainCap\(session\?\.plan\)/);
  });
});
