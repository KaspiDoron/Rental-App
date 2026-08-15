import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { allSettled } from "./readiness";

describe("a page is loading until all of it has loaded", () => {
  const SOURCES = ["session", "trips"] as const;

  it("one source arriving is NOT the page arriving", () => {
    // The live failure: Trips ran two requests, `loading` belonged to one of
    // them, and the placeholder came down while the other was still in flight -
    // so the traveller saw a finished-looking page with nothing in it.
    expect(allSettled(SOURCES, { trips: true })).toBe(false);
    expect(allSettled(SOURCES, { session: true })).toBe(false);
  });

  it("every source arriving IS", () => {
    expect(allSettled(SOURCES, { session: true, trips: true })).toBe(true);
  });

  it("a source that failed still counts as settled", () => {
    // Holding a placeholder up forever is a worse lie than an empty state.
    expect(allSettled(["a"], { a: true })).toBe(true);
  });

  it("no sources means nothing to wait for", () => {
    expect(allSettled([], {})).toBe(true);
  });
});

describe("the placeholder looks alive, in both themes", () => {
  const css = () => readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("the dark shimmer is actually visible", () => {
    // It was 7% white on a dark plate - invisible on a phone, which is what
    // "ten seconds of nothingness" was describing. The floor is unchanged; only
    // where it lives has moved. The dark sweep used to be a whole duplicated
    // `[data-theme="dark"] .skeleton::after` gradient; it is now one token in
    // the dark theme block, which is what let the sheen become achromatic
    // without maintaining two copies of the same five gradient stops.
    const src = css();
    const dark = src.slice(src.indexOf('[data-theme="dark"] {'));
    const peak = dark.match(/--wd-skel-sheen: rgba\(255, 255, 255, (0\.\d+)\)/);
    expect(peak, "the dark theme must define its own sheen").toBeTruthy();
    expect(Number(peak![1])).toBeGreaterThanOrEqual(0.15);
  });

  it("the plate breathes, so a still frame still reads as working", () => {
    expect(css()).toMatch(/animation: skeleton-breathe/);
  });

  it("reduced motion keeps the placeholder, drops the movement", () => {
    const src = css();
    const block = src.slice(src.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.skeleton \{ animation: none; \}/);
  });
});

describe("Trips waits for everything it needs", () => {
  it("declares its sources and settles each one", () => {
    const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");
    expect(page).toMatch(/const TRIPS_SOURCES = \["session", "trips"\] as const/);
    expect(page).toMatch(/useReadiness\(TRIPS_SOURCES\)/);
    expect(page).toMatch(/settle\("session"\)/);
    expect(page).toMatch(/settle\("trips"\)/);
    // The old shape: one fetch owned the flag for the whole page.
    expect(page).not.toMatch(/setLoading\(false\)/);
  });
});
