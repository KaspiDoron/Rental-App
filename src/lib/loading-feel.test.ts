import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { shouldShowLoading, LOADING_GRACE_MS, LOADING_MIN_MS } from "./client/min-duration";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE LOADING STATE LOOKED CHEAP (items 1 and 12), in three separate ways.
//
// 1. The dots used Tailwind's `animate-bounce` - a hard translate on an
//    asymmetric cubic-bezier. That is a ball dropping, which is the shape of a
//    physics toy rather than of something thinking.
// 2. There was no ambient layer at the PAGE level at all. `.aurora::before` is
//    box-scoped (inset:-14%), so a full-screen wait was a small spinner on flat
//    background.
// 3. There was NO minimum-duration logic anywhere in the repo, so every fast
//    response drew a spinner for ~80ms and tore it down. The eye catches the
//    change without resolving it, and fast reads as broken.

describe("the timing contract - no flash, no forced wait", () => {
  const t0 = 1_000_000;

  it("work that finishes inside the grace period never shows anything", () => {
    // The whole point of the DELAY half. Without it, a minimum-duration rule
    // makes things worse: a 60ms fetch would be held on screen for 400ms and
    // turn instant into visibly slow.
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: t0 + 60, nowMs: t0 + 61 })
    ).toBe(false);
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: t0 + 60, nowMs: t0 + 5000 })
    ).toBe(false);
  });

  it("...and nothing is drawn during the grace period either", () => {
    expect(shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + 10 })).toBe(false);
  });

  it("slow work shows the indicator once the grace passes", () => {
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + LOADING_GRACE_MS })
    ).toBe(true);
    expect(shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + 3000 })).toBe(true);
  });

  it("once shown, it is held long enough to READ", () => {
    // Finished just after appearing: still held.
    const endedAt = t0 + LOADING_GRACE_MS + 20;
    expect(shouldShowLoading({ startedAt: t0, endedAt, nowMs: endedAt + 1 })).toBe(true);
  });

  it("...measured from when it APPEARED, not from when the work started", () => {
    // Holding from `startedAt` would cut the visible time short by the whole
    // grace period - the indicator would flash for less than the minimum it is
    // supposed to guarantee.
    const shownAt = t0 + LOADING_GRACE_MS;
    const endedAt = shownAt + 10;
    expect(
      shouldShowLoading({ startedAt: t0, endedAt, nowMs: shownAt + LOADING_MIN_MS - 1 })
    ).toBe(true);
    expect(
      shouldShowLoading({ startedAt: t0, endedAt, nowMs: shownAt + LOADING_MIN_MS + 1 })
    ).toBe(false);
  });

  it("idle is idle", () => {
    expect(shouldShowLoading({ startedAt: null, endedAt: null, nowMs: t0 })).toBe(false);
  });

  it("the grace is shorter than the hold, or the rule contradicts itself", () => {
    expect(LOADING_GRACE_MS).toBeLessThan(LOADING_MIN_MS);
  });
});

describe("the dots breathe rather than bounce", () => {
  const dots = readCode("src/components/LoadingDots.tsx");
  const css = read("src/app/globals.css");

  it("Tailwind's ball-drop is gone", () => {
    expect(dots).not.toMatch(/animate-bounce/);
    expect(dots).toMatch(/wd-dot-breathe/);
  });

  it("the keyframe is scale + opacity on a SYMMETRIC ease", () => {
    // An asymmetric bezier is what makes `animate-bounce` read as gravity.
    const kf = /@keyframes wd-breathe \{[\s\S]*?\n\}/.exec(css);
    expect(kf, "wd-breathe moved").toBeTruthy();
    expect(kf![0]).toMatch(/transform: scale/);
    expect(kf![0]).toMatch(/opacity/);
    expect(css).toMatch(/\.wd-dot-breathe[\s\S]{0,200}cubic-bezier\(0\.4, 0, 0\.6, 1\)/);
  });

  it("the stagger is NEGATIVE, so they do not light up in a row", () => {
    expect(dots).toMatch(/-0\.45 \+ i \* 0\.18/);
  });

  it("reduced motion gets a still dot, not a frozen half-scaled one", () => {
    const rm = css.slice(css.indexOf(".wd-dot-breathe"));
    expect(rm).toMatch(/prefers-reduced-motion[\s\S]{0,220}animation: none/);
    expect(rm).toMatch(/prefers-reduced-motion[\s\S]{0,260}transform: none/);
  });
});

describe("there is an ambient layer at the page level", () => {
  const css = read("src/app/globals.css");

  it("it is viewport-fixed and cannot eat taps", () => {
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css);
    expect(amb, ".wd-ambient moved").toBeTruthy();
    expect(amb![0]).toMatch(/position: fixed/);
    expect(amb![0]).toMatch(/pointer-events: none/);
  });

  it("it uses the brand hue tokens, not invented colours", () => {
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0];
    for (const v of ["--wd-hue-1", "--wd-hue-2", "--wd-hue-3"]) {
      expect(amb, v).toContain(v);
    }
  });

  it("...and it sits BEHIND the content, not over it", () => {
    expect(/\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0]).toMatch(/z-index: 0/);
  });
});

describe("the shop photo holds its space while it loads", () => {
  const photo = readCode("src/components/ShopPhoto.tsx");

  it("a placeholder is drawn until the image decodes", () => {
    expect(photo).toMatch(/shop-photo-placeholder/);
    expect(photo).toMatch(/onLoad=\{\(\) => setLoaded\(true\)\}/);
  });

  it("the image fades in rather than popping", () => {
    expect(photo).toMatch(/transition-opacity/);
  });

  it("a broken photo still falls back honestly, as before", () => {
    // The failure path predates this and must survive it: a dead Places SKU
    // shows a calm panel, never the browser's broken-image glyph.
    expect(photo).toMatch(/if \(!src \|\| broken\)/);
  });
});

describe("the proxy lets anything cache the photo", () => {
  const route = readCode("src/app/api/photo/route.ts");

  it("the CDN gets an s-maxage, not just the browser", () => {
    // `max-age` alone tells a CDN nothing, so every viewer of every shop
    // re-fetched an 800px original through this Node route.
    expect(route).toMatch(/s-maxage=/);
    expect(route).toMatch(/immutable/);
  });

  it("...and the upstream fetch stopped forcing a miss", () => {
    expect(route).not.toMatch(/cache: "no-store",\s*\n\s*signal/);
    expect(route).toMatch(/cache: "force-cache"/);
  });

  it("a FAILED photo is still never cached", () => {
    // Caching a 502 would pin a transient Places outage onto every viewer.
    expect(route).toMatch(/FAIL_HEADERS = \{ "Cache-Control": "private, no-store" \}/);
  });
});
