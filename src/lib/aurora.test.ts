import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { AURORA, aurora } from "./aurora";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const css = readRaw("src/app/globals.css");
const skeleton = stripComments(readRaw("src/components/Skeleton.tsx"));
const veil = stripComments(readRaw("src/components/NavVeil.tsx"));

// M5 + M16: ONE SHARED PRIMITIVE, NOT A PARALLEL SET.
//
// The module text is explicit that the Aurora glow reuses the existing
// Skeleton / LoadingDots / NavVeil rather than shipping beside them, and the
// reason is the failure this codebase keeps re-learning: a second
// implementation of one idea drifts from the first, and then two screens
// disagree about what waiting looks like.

describe("the glow has exactly one name", () => {
  it("the class is a constant, not a literal typed per component", () => {
    expect(AURORA).toBe("aurora");
  });

  it("aurora() returns the class or nothing", () => {
    expect(aurora(true)).toBe("aurora");
    expect(aurora(false)).toBe("");
    expect(aurora()).toBe("aurora");
  });

  it("no component spells the class out by hand", () => {
    // A hand-typed "aurora" is how renaming or retiring the effect turns into
    // a hunt for string literals.
    //
    // RELATIVE import, not `@/lib/aurora`. The vitest harness resolves no path
    // alias, and Skeleton is reachable from a rendering test
    // (AuthMethodList.test.tsx), so an aliased import here fails the suite at
    // module load - which is how this was caught.
    for (const [name, src] of [
      ["Skeleton", skeleton],
      ["NavVeil", veil],
    ] as const) {
      expect(src, `${name} should import the constant`).toMatch(/from "\.\.\/lib\/aurora"/);
      expect(src, `${name} should not hardcode the class`).not.toMatch(/"aurora"|'aurora'/);
    }
  });
});

describe("it is composed onto what already exists", () => {
  it("SkeletonCard wears it, and glowing is the default", () => {
    // A skeleton card is by definition a surface with work behind it, so the
    // default has to be the honest one.
    expect(skeleton).toMatch(/glow = true/);
    expect(skeleton).toMatch(/\$\{aurora\(glow\)\}/);
  });

  it("only the FIRST card in a list glows", () => {
    // Ten glowing cards is a light show, not a status.
    expect(skeleton).toMatch(/glow=\{i === 0\}/);
  });

  it("the nav veil wears the same glow, so the app has one answer", () => {
    expect(veil).toMatch(/\$\{AURORA\}/);
  });

  it("the glow is on a WRAPPER, not baked into OrbitDots", () => {
    // OrbitDots is used in places that are not loading states; a primitive
    // that cannot be used without its glow is not a primitive.
    const dots = readRaw("src/components/OrbitDots.tsx");
    expect(dots).not.toMatch(/aurora/i);
  });

  it("no parallel loading component was created", () => {
    // The whole point of M5/M16 is that this is ONE primitive. A new
    // AuroraSpinner / AuroraCard / AuroraSkeleton would be the parallel set
    // the module forbids.
    const { readdirSync } = require("fs") as typeof import("fs");
    const names = readdirSync(join(process.cwd(), "src/components"));
    expect(names.filter((n: string) => /^Aurora/i.test(n))).toEqual([]);
  });
});

describe("the CSS is one definition and it degrades", () => {
  it("the class exists once", () => {
    expect((css.match(/^\.aurora \{/gm) ?? []).length).toBe(1);
  });

  it("it is pure CSS - no JS drives the animation", () => {
    // A JS-driven glow on a loading screen competes for the main thread with
    // the very work the user is waiting for.
    expect(css).toMatch(/@keyframes aurora-drift/);
    expect(css).toMatch(/@keyframes aurora-breathe/);
    const lib = readRaw("src/lib/aurora.ts");
    expect(lib).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
  });

  it("reduced motion keeps the colour and drops the travel", () => {
    // The same contract .skeleton already honours - a visible placeholder that
    // holds still, not an invisible one.
    const block = css.slice(css.indexOf(".aurora {"));
    const reduced = block.slice(block.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced.slice(0, 260)).toMatch(/\.aurora::before,\s*\n\s*\.aurora::after \{ animation: none; \}/);
    expect(reduced.slice(0, 260)).toMatch(/opacity: 0\.4/);
  });

  it("the bloom sits behind the content and never eats a tap", () => {
    const block = css.slice(css.indexOf(".aurora::before"), css.indexOf(".aurora::after"));
    expect(block).toMatch(/z-index: -1/);
    expect(block).toMatch(/pointer-events: none/);
  });

  it("both pseudo-elements are non-interactive", () => {
    const after = css.slice(css.indexOf(".aurora::after"));
    expect(after.slice(0, 700)).toMatch(/pointer-events: none/);
  });

  it("the edge is masked to the border, so a rounded card gets no double rim", () => {
    const after = css.slice(css.indexOf(".aurora::after"));
    expect(after.slice(0, 900)).toMatch(/mask-composite: exclude/);
    expect(after.slice(0, 900)).toMatch(/border-radius: inherit/);
  });

  it("dark mode trades the weight rather than washing out", () => {
    // The bloom carries it in the dark, the rim carries it in daylight - the
    // lesson the skeleton shimmer learned the hard way.
    expect(css).toMatch(/\[data-theme="dark"\] \.aurora::before/);
    expect(css).toMatch(/\[data-theme="dark"\] \.aurora::after/);
  });
});
