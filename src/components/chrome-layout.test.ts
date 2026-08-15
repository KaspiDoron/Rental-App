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
    // The canvas div moved into PageFade (keyed per pathname so the fade
    // re-runs on client navigations); the layout must still mount it around
    // the route children.
    expect(read("src/app/layout.tsx")).toMatch(/<PageFade>\{children\}<\/PageFade>/);
    expect(read("src/components/PageFade.tsx")).toMatch(/className="app-canvas[^"]*"/);
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
    const el = read("src/components/PageFade.tsx").match(/className="(app-canvas[^"]*)"/);
    expect(el).toBeTruthy();
    expect(el![1].trim().split(/\s+/).sort()).toEqual(["app-canvas", "page-fade"]);
    // ...and it is keyed on the pathname - that is the whole reason the
    // wrapper exists as a client component.
    expect(read("src/components/PageFade.tsx")).toMatch(/key=\{pathname\}/);
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
    expect(read("src/components/PageFade.tsx")).not.toMatch(/app-canvas[^"]*fluid-in/);
  });

  it("Will is portalled too, on a host that carries no transform of its own", () => {
    // His card is `position: fixed` at viewport coordinates from
    // getBoundingClientRect. Rendered inline he was measured against the
    // viewport and painted against a glass card - so he left the screen.
    const w = read("src/components/will/WillGuideOverlay.tsx");
    expect(w).toMatch(/<FixedLayer hostIsFixed=\{false\}>/);
    const f = read("src/components/FixedLayer.tsx");
    // The shape changed with the keyboard fix but the CLAIM is intact: a
    // hostIsFixed layer composites itself (translateZ), a non-fixed host
    // passes `style` through UNTOUCHED - any transform on it would become its
    // fixed children's containing block and re-create the mid-screen bug.
    expect(f).toMatch(/hostIsFixed\s*\?\s*\{[\s\S]{0,600}translateZ\(0\)[\s\S]{0,600}\}\s*:\s*style/);
    expect(f).not.toMatch(/hostIsFixed\s*\?[\s\S]{0,600}:\s*\{[\s\S]{0,60}transform/);
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
  /** EVERY `.substick` rule, not just the first one.
   *
   *  This used to `indexOf(".substick {")` and inspect that one block, which
   *  meant the ABSENCE assertions below only ever examined the first
   *  declaration in the file. An adversarial pass proved the hole: a duplicate
   *  rule appended at the end of the stylesheet, a re-stick inside a media
   *  query, and a re-stick via a compound selector added later ALL re-pinned
   *  the bar in a real browser while every assertion here still passed. The
   *  cascade does not care which block came first, so neither can this.
   *
   *  Returns the concatenation of every rule whose selector list mentions
   *  `.substick`, so "the bar is never given positioning" is asserted against
   *  all of them at once. */
  const substickBlock = () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = src.match(/[^{}]*\.substick[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.length, ".substick block not found").toBeGreaterThan(0);
    return rules.join("\n");
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

  it("the views bar is NOT sticky - it scrolls off with the page", () => {
    // The owner's report: the List/Map/Activity + Feed/Swipe bar pinned below
    // the top bar and ate ~89px of every screen. It is in-flow now. Pin the
    // ABSENCE of every positioning declaration so a future 'make it sticky
    // again' cannot pass silently.
    const b = substickBlock();
    expect(b).not.toMatch(/position:\s*sticky/);
    // A bare `top:` property (not `scroll-margin-top`, which is kept): the char
    // before a real positioning `top:` is whitespace or `{`, never a hyphen.
    expect(b).not.toMatch(/[^-]top:/);
    expect(b).not.toMatch(/z-index/);
    // Still opaque with no per-frame blur (it sits over the scrolling list),
    // and it carries a scroll-margin so the jump-to-views links land BELOW the
    // sticky top bar rather than under it.
    expect(b).toMatch(/background:\s*var\(--card\)/);
    expect(b).toMatch(/backdrop-filter:\s*none/);
    expect(b).toMatch(/scroll-margin-top:\s*var\(--topbar-h\)/);
    // ...and it is out of the collapse transform entirely - a non-sticky
    // element must never receive the top bar's collapse translate.
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/\.substick\[data-collapsed="true"\]/);
  });

  it("EVERY jump target carries the scroll-margin, not just the views bar", () => {
    // `goToSection` addresses two anchors. Only `.substick` had the margin, so
    // jumping to the shop list buried the first card's name row, rating and
    // distance under the sticky top bar - and on a notched phone, most of the
    // card, in both scroll directions once reduced-motion stops the top bar
    // collapsing. Both anchors must clear it.
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const targets =
      read("src/app/page.tsx").match(/goToSection\(\s*["'`]\[data-tour=['"]?([a-z-]+)/g) ?? [];
    expect(targets.length, "no goToSection call sites found - did the selector change?")
      .toBeGreaterThan(0);
    for (const call of new Set(targets)) {
      const name = /data-tour=['"]?([a-z-]+)/.exec(call)![1];
      // The margin may come from the anchor's own class or an attribute rule;
      // what matters is that SOMETHING gives this selector the clearance.
      const viaAttr = new RegExp(`\\[data-tour="${name}"\\][^{}]*\\{[^}]*scroll-margin-top`);
      const viaClass = name === "views" && /\.substick\s*\{[^}]*scroll-margin-top/.test(src);
      expect(
        viaAttr.test(src) || viaClass,
        `goToSection targets [data-tour=${name}] but nothing gives it scroll-margin-top`
      ).toBe(true);
    }
  });

  it("the top bar height is still a CSS contract, measured by nothing", () => {
    // Unchanged by the un-stick: the TOP bar stays sticky at its declared
    // height. It used to be measured by a mounted <TopbarMetrics> with a
    // ResizeObserver, written to documentElement as a custom property - a loop
    // that is gone by construction.
    expect(read("src/app/page.tsx")).not.toMatch(/substick top-\d/);
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

describe("the bottom-right stack has named slots, like the z ladder", () => {
  const css = () => read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("the slots exist beside the layer ladder", () => {
    for (const t of ["--stack-bottom-0", "--stack-bottom-1", "--stack-bottom-2"]) {
      expect(css(), t).toContain(`${t}: calc(env(safe-area-inset-bottom, 0px)`);
    }
  });

  it("the FAB and the Ask Will chip consume slots, not hand-picked rems", () => {
    // Hard-coded offsets are how two elements ended up in one band with no
    // owner: each guessed a bigger number than whatever it lost to last time.
    expect(read("src/components/StatusFab.tsx")).toMatch(/bottom: "var\(--stack-bottom-1\)"/);
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/"var\(--stack-bottom-2\)"/);
    expect(page).toMatch(/"var\(--stack-bottom-0\)"/);
    expect(page).not.toMatch(/bottom:\s*"calc\(env\(safe-area-inset-bottom, 0px\) \+ 8\.5rem\)"/);
  });

  it("the upgrade pill yields its band to the status FAB", () => {
    // The centered pill and the right-aligned FAB share one vertical band;
    // at 320px their widths met in the middle and the FAB could not be
    // pressed. One occupant per band: while the FAB can mount, the pill
    // stands down (pricing stays reachable in the tab bar).
    const page = read("src/app/page.tsx");
    expect(page).toMatch(
      /showUpgrade=\{\s*!upgradeOpen && !paidPlan && !onboarding && !\(vendors\.length > 0 && view === "list"\)\s*\}/
    );
  });
});
