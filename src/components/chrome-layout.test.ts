import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// WHY THIS FILE EXISTS
//
// The bottom navigation has now rendered halfway up the page twice. Both times
// the fix addressed the symptom - portal it to <body>, promote it to its own
// compositing layer - and both times it came back, because the actual cause is
// one CSS declaration that is very easy to re-add while fixing something else:
//
//     html, body { overflow-x: hidden }
//
// A non-visible overflow on the ROOT element hands page scrolling to the body
// box, and a `position: fixed` child of body then pins to the DOCUMENT instead
// of the viewport. No amount of portalling beats that - the rule is about which
// box scrolls, not about who the parent is. So the invariant is pinned here.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = () => read("src/app/globals.css");

describe("the viewport keeps its scrolling, so fixed chrome stays fixed", () => {
  it("the ROOT never clips overflow", () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    // Find the `html, body { ... }` block and assert it carries no overflow.
    const m = src.match(/html\s*,\s*body\s*\{([^}]*)\}/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/overflow/);
    expect(src).not.toMatch(/^\s*body\s*\{[^}]*overflow-x/m);
  });

  it("the canvas clips instead, and with `clip` rather than `hidden`", () => {
    const src = css();
    expect(src).toMatch(/\.app-canvas\s*\{[^}]*overflow-x:\s*clip/);
  });

  it("the canvas actually wraps the pages", () => {
    // `fluid-in` rides along on the same element - the arrival animation.
    expect(read("src/app/layout.tsx")).toMatch(/className="app-canvas[^"]*"/);
  });

  it("chrome that must stay on screen still portals out of the canvas", () => {
    const bar = read("src/components/TabBar.tsx");
    expect(bar).toMatch(/<FixedLayer className="fixed inset-x-0 bottom-0 z-50/);
    expect(read("src/components/FixedLayer.tsx")).toMatch(/createPortal\(/);
  });

  it("every page still reserves room under the floating bar", () => {
    for (const p of ["src/app/page.tsx", "src/app/deals/page.tsx", "src/app/profile/page.tsx"]) {
      expect(read(p)).toMatch(/<main className="[^"]*pb-32/);
    }
  });
});

describe("the bar looks like glass, and degrades to something solid", () => {
  it("is a floating capsule, not a full-bleed cap", () => {
    const src = css();
    const bar = src.slice(src.indexOf(".tabbar {"), src.indexOf("}", src.indexOf(".tabbar {")) + 1);
    expect(bar).toMatch(/border-radius/);
    expect(bar).toMatch(/margin:/);
    expect(bar).toMatch(/backdrop-filter:\s*blur/);
    // The inset lines are what read as an edge of glass rather than a border.
    expect(bar).toMatch(/inset 0 1px 0 0/);
  });

  it("a browser with no backdrop-filter gets an OPAQUE bar", () => {
    // Otherwise the page's text scrolls visibly under the navigation.
    expect(css()).toMatch(
      /@supports not \(\(backdrop-filter[\s\S]{0,160}\.tabbar \{ background: var\(--card\); \}/
    );
  });

  it("the safe-area gap is outside the capsule, so the glass floats", () => {
    const bar = read("src/components/TabBar.tsx");
    expect(bar).toMatch(/bottom-0 z-50 pb-safe/);
    expect(bar).not.toMatch(/className="tabbar pb-safe"/);
  });
});
