import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Every shop photo in the app went blank at once. The proxy answered each of
// its four distinct failures - bad input, no key, Google refusing, a timeout -
// with the same bare 404 and no log, and the Maps doctor never fetched an
// image, so the diagnostics panel read all-green while nothing rendered.
//
// These pin the properties that make that undiagnosable-by-construction state
// impossible again. They are source-level for the same reason the other
// hardening invariants are: the behaviour is integration-bound.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const ROUTE = "src/app/api/photo/route.ts";

describe("photo proxy: every failure says which one it was", () => {
  it("distinguishes bad input, missing key and an upstream refusal", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/400.*malformed|malformed.*400/s);
    expect(code).toMatch(/503/); // no key configured - an operator problem
    expect(code).toMatch(/502/); // upstream refused - Google's problem
  });

  it("surfaces Google's own words instead of swallowing them", () => {
    const code = readCode(ROUTE);
    // "Places API has not been used in project X" and "quota exceeded" need
    // different fixes; the old bare 404 hid both.
    expect(code).toMatch(/error\?\.message/);
    expect(code).toMatch(/X-Photo-Error/);
    expect(code).toMatch(/console\.warn/);
  });

  it("never caches a failure - once broken must not stay broken", () => {
    const code = readCode(ROUTE);
    expect(code).toMatch(/private,\s*no-store/);
    // Success is still publicly cacheable: a shop photo is the same for everyone.
    expect(code).toMatch(/public,\s*max-age=86400/);
  });

  it("only streams something that is actually an image", () => {
    expect(readCode(ROUTE)).toMatch(/startsWith\(["']image\//);
  });
});

describe("photo proxy: still un-injectable", () => {
  it("anchors both input shapes and forbids query/path characters", () => {
    const code = readCode(ROUTE);
    const nameRx = /const NAME_RX = (\/.*\/);/.exec(code)?.[1];
    const refRx = /const REF_RX = (\/.*\/);/.exec(code)?.[1];
    expect(nameRx).toBeTruthy();
    expect(refRx).toBeTruthy();
    // eslint-disable-next-line no-eval
    const NAME = eval(nameRx!) as RegExp;
    // eslint-disable-next-line no-eval
    const REF = eval(refRx!) as RegExp;

    // A "?" would turn /media?key=... into an arbitrary authenticated call
    // billed to the owner's key. That is the whole reason these exist.
    expect(NAME.test("places/abc/photos/def?x=1")).toBe(false);
    expect(NAME.test("places/abc/photos/def&x=1")).toBe(false);
    expect(NAME.test("places/abc/photos/def#f")).toBe(false);
    expect(NAME.test("places/abc/photos/../../evil")).toBe(false);
    expect(NAME.test("../places/abc/photos/def")).toBe(false);
    expect(REF.test("abc?x=1")).toBe(false);
    expect(REF.test("abc/def")).toBe(false);

    // ...while accepting the shapes Google actually issues, including the very
    // long URL-safe ids the New API returns.
    expect(NAME.test("places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AeJbb3cBjmJo-Lx_9")).toBe(true);
    expect(NAME.test(`places/ChIJabc/photos/${"A".repeat(1200)}`)).toBe(true);
    expect(REF.test("Aap_uEA7vb0DDYVJWEaX3O-AtYp77AaswQKSGtDaimt3gt7QCNpdjp1BkdM6acJ96xTec3tsV_ZJNL_JP-lqsVxydG3nh739RE_hepOOL05tfJh2_ranjMadb3VoBYFvF0ma6S24qZ6QJUuV6sSRrhCskSBP5C1myCzsebztMfGvm7ij3gZT")).toBe(true);
  });
});

describe("the Maps doctor actually fetches an image", () => {
  it("probes Place Photos as its own check", () => {
    const g = readCode("src/lib/google.ts");
    expect(g).toMatch(/placePhotos/);
    expect(g).toMatch(/probePlacePhoto/);
    // It must pull real bytes, not just assert the search worked - that is the
    // gap that let the panel report green while every photo was broken.
    expect(g).toMatch(/\/media\?key=/);
    expect(g).toMatch(/startsWith\("image\//);
  });

  it("the admin panel reports it, and fails overall when photos fail", () => {
    const page = readCode("src/app/admin/page.tsx");
    expect(page).toMatch(/Place Photos:/);
    expect(page).toMatch(/d\.placePhotos\?\.ok/);
  });
});

describe("the UI degrades instead of showing a broken-image glyph", () => {
  it("every shop-photo surface renders through ShopPhoto", () => {
    for (const f of [
      "src/components/VendorCard.tsx",
      "src/components/MapView.tsx",
      "src/components/ThreadDashboard.tsx",
    ]) {
      const code = readCode(f);
      expect(code).toMatch(/<ShopPhoto/);
      // No raw <img> left on a vendor photo to show the browser's "?" box.
      expect(code).not.toMatch(/<img[^>]*src=\{(vendor\.photoUrl|v\.photoUrl|photos\[0\])/);
    }
  });

  it("ShopPhoto falls back on error and keeps the same footprint", () => {
    const code = readCode("src/components/ShopPhoto.tsx");
    expect(code).toMatch(/onError=/);
    expect(code).toMatch(/broken/);
  });

  it("the gallery says so when EVERY photo failed, instead of a black void", () => {
    expect(readCode("src/components/PhotoGallery.tsx")).toMatch(/visible\.length === 0/);
  });
});
