import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
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
    expect(read("src/app/layout.tsx")).toMatch(/className="app-canvas[^"]*"/);
  });

  it("NOTHING on the canvas may create a containing block", () => {
    // The third regression, and a different cause from the first two: an
    // `animation: ... both` whose last keyframe sets `transform` and `filter`
    // retains BOTH forever, and either one makes every `position: fixed`
    // descendant pin to the document. That is what sent the bar into the middle
    // of the page and Will off the edge of the screen.
    //
    // Checked as a list of PROPERTIES rather than "don't use fluid-in", because
    // the next trap will have a different class name and the same effect.
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [...src.matchAll(/\.app-canvas[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    const FORBIDDEN =
      /(^|[\s;])(transform|filter|backdrop-filter|perspective|contain|will-change|animation)\s*:/;
    for (const b of blocks) expect(b).not.toMatch(FORBIDDEN);
  });

  it("...and the classes it wears are only the two safe ones", () => {
    const el = read("src/app/layout.tsx").match(/className="(app-canvas[^"]*)"/);
    expect(el).toBeTruthy();
    expect(el![1].trim().split(/\s+/).sort()).toEqual(["app-canvas", "page-fade"]);
  });

  it("the page arrival animates OPACITY only - opacity creates no containing block", () => {
    const src = css();
    const kf = src.slice(src.indexOf("@keyframes page-fade"));
    const body = kf.slice(0, kf.indexOf("}", kf.indexOf("to {")) + 2);
    expect(body).toMatch(/opacity/);
    expect(body).not.toMatch(/transform|filter|scale|translate/);
  });

  it("the liquid rise stays on CONTENT, which never holds fixed chrome", () => {
    // `fluid-in` genuinely does set a transform and a blur - that is what makes
    // it read as liquid. It is fine on cards and rows; it is a trap on a wrapper.
    expect(read("src/app/layout.tsx")).not.toMatch(/app-canvas[^"]*fluid-in/);
  });

  it("Will is portalled too, on a host that carries no transform of its own", () => {
    // His card is `position: fixed` at viewport coordinates from
    // getBoundingClientRect. Rendered inline he was measured against the
    // viewport and painted against a glass card - so he left the screen.
    const w = read("src/components/will/WillGuideOverlay.tsx");
    expect(w).toMatch(/<FixedLayer hostIsFixed=\{false\}>/);
    const f = read("src/components/FixedLayer.tsx");
    expect(f).toMatch(/hostIsFixed \? \{ transform: "translateZ\(0\)", \.\.\.style \} : style/);
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

// THE TOP BAR IS THE TOP.
//
// Two separate complaints with one cause: the bar was a translucent plate with
// `backdrop-filter`, and it was `position: sticky`. Translucent means the page
// stays readable through it - that is the "I can see behind it". Sticky +
// backdrop-filter means the browser re-samples and re-blurs whatever is behind
// the bar on EVERY frame of EVERY scroll, for the whole length of the list -
// that is the lag. Glass is a chrome material you pay for once or twice on a
// screen; it is not a material for anything that scrolls or repeats.
describe("the top bar is the top", () => {
  const block = (sel: string) => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const i = src.indexOf(sel + " {");
    expect(i, `${sel} block not found`).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf("}", i) + 1);
  };
  /** The `.substick` rule that positions it - not the shared transition rule
   *  it now co-signs with `.topbar`. */
  const stickyBlock = () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const m = src.match(/\.substick\s*\{[^}]*position:\s*sticky[^}]*\}/);
    expect(m, ".substick positioning block not found").toBeTruthy();
    return m![0];
  };

  it("is opaque - the page does not read through it", () => {
    const b = block(".topbar");
    expect(b).toMatch(/background:\s*var\(--bg\)\s*;/);
    // `color-mix(... transparent)` is exactly how it went see-through before.
    expect(b).not.toMatch(/transparent/);
  });

  it("samples nothing per frame, which is where the scroll lag came from", () => {
    expect(block(".topbar")).not.toMatch(/backdrop-filter/);
  });

  it("...and still reads as premium, from things that cost nothing to paint", () => {
    const b = block(".topbar");
    expect(b).toMatch(/border-bottom:/);
    expect(b).toMatch(/box-shadow:/);
  });

  it("its layer is a shared token, so nothing sits above it by accident", () => {
    const src = css();
    expect(src).toMatch(/--topbar-z:\s*\d+/);
    expect(block(".topbar")).toMatch(/z-index:\s*var\(--topbar-z\)/);
  });

  it("anything that sticks below is strictly one layer down, by construction", () => {
    const b = stickyBlock();
    expect(b).toMatch(/z-index:\s*calc\(var\(--topbar-z\) - 1\)/);
    // Opaque too: a translucent second sticky row was the other half of it.
    expect(b).toMatch(/background:\s*var\(--card\)/);
    // ...and a utility class must not smuggle a per-frame blur back in. A
    // STICKY element with a backdrop-filter re-samples its backdrop on every
    // frame of every scroll - the exact cost the top bar was made opaque to
    // remove, and the sub-nav sits over the same scrolling list.
    expect(b).toMatch(/backdrop-filter:\s*none/);
  });

  it("...and lands on the bar's DECLARED height, which nothing measures", () => {
    // `top-16` was a 64px guess. Too small hides the row under the bar; too
    // large leaves a strip of the scrolling page showing between them.
    expect(stickyBlock()).toMatch(/top:\s*var\(--topbar-h\)/);
    expect(read("src/app/page.tsx")).not.toMatch(/substick top-\d/);

    // THE HEIGHT IS A CONTRACT NOW, NOT AN OBSERVATION. It used to be measured
    // by a mounted <TopbarMetrics> with a ResizeObserver, written to
    // documentElement as a custom property. Custom properties INHERIT, so every
    // write invalidated style for the whole document; worse, `.substick` parks
    // at that value, so a write moved the pinned sub-nav mid-scroll - and on a
    // phone `resize` fires continuously while the URL bar collapses DURING a
    // scroll. That loop is the reported jump, and it is gone by construction.
    const src = css();
    expect(src).toMatch(/--topbar-row-h:\s*[\d.]+rem/);
    expect(src).toMatch(/--topbar-h:\s*calc\(var\(--safe-top\) \+ var\(--topbar-row-h\)\)/);
    expect(block(".topbar")).toMatch(/height:\s*var\(--topbar-h\)/);
    expect(src).not.toMatch(/setProperty\("--topbar-h"/);
    expect(read("src/app/layout.tsx")).not.toMatch(/TopbarMetrics/);
    expect(existsSync(join(process.cwd(), "src/components/TopbarMetrics.tsx"))).toBe(false);
  });

  it("the sub-row no longer carries its own z-index or sticky class", () => {
    // Both are the class's job now - a per-call-site number is what drifts.
    const p = read("src/app/page.tsx");
    const m = p.match(/className="[^"]*\bsubstick\b[^"]*"/g) ?? [];
    expect(m.length).toBeGreaterThan(0);
    for (const c of m) {
      expect(c).not.toMatch(/\bz-\d/);
      expect(c).not.toMatch(/\bsticky\b/);
    }
  });
});

describe("glass is chrome, not content", () => {
  it("there is a solid twin with the same edge and no per-frame sampling", () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const i = src.indexOf(".glass-solid {");
    expect(i).toBeGreaterThan(-1);
    const b = src.slice(i, src.indexOf("}", i) + 1);
    expect(b).not.toMatch(/backdrop-filter/);
    expect(b).toMatch(/background:\s*var\(--card\)/);
    // The look survives: the inset highlight is what reads as an edge of glass.
    expect(b).toMatch(/inset 0 1px 0 0/);
  });

  it("surfaces that REPEAT or SCROLL use the solid twin", () => {
    // A list pays the blur once per card per frame for a refraction nobody can
    // see behind an opaque card anyway.
    for (const p of ["src/app/deals/page.tsx", "src/components/Skeleton.tsx"]) {
      expect(read(p)).toMatch(/glass-solid/);
    }
    // Bare `glass` only - `glass-solid` and `glass-rim` are the wanted ones.
    const sk = read("src/components/Skeleton.tsx").replace(/\/\/.*$/gm, "");
    expect(sk).not.toMatch(/\bglass(?![-\w])/);
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
