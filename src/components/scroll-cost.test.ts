import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const css = () => read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

// THE LOGO ROW STUTTERED AND JUMPED WHILE SCROLLING.
//
// Removing the top bar's backdrop-filter fixed one cost and revealed four
// more, none of them in the bar's own styling:
//
//   1. FixedLayer setState on every visualViewport scroll event - re-rendering
//      the portalled, backdrop-filtered tab bar per frame, then rewriting a DOM
//      attribute specifically to force a style recalculation.
//   2. WillGuideOverlay measuring layout on every scroll event, allocating a
//      fresh rect object so React could never bail, then reading the card's
//      rect again after React had written to it - a forced sync reflow, twice.
//   3. DomTranslator writing nodeValue unconditionally; "replace data" always
//      queues a characterData record, and its own observer treats that as a
//      reason to re-walk the whole body - a self-feeding 400ms loop.
//   4. THE JUMP: the brand tagline could wrap, so the bar's height changed
//      whenever anything on the row changed width, republishing --topbar-h and
//      moving the sticky row below it.

describe("nothing does React work per scroll event", () => {
  it("the fixed layer no longer re-renders on scroll", () => {
    const f = readCode("src/components/FixedLayer.tsx");
    expect(f).not.toMatch(/addEventListener\("scroll"/);
    // The artifact it guards is a viewport RESIZE effect; those still fire.
    expect(f).toMatch(/addEventListener\("resize"/);
    expect(f).toMatch(/orientationchange/);
  });

  it("Will's overlay measures at most once per frame", () => {
    const w = readCode("src/components/will/WillGuideOverlay.tsx");
    expect(w).toMatch(/requestAnimationFrame\(read\)|requestAnimationFrame\(\(\) => \{/);
    expect(w).toMatch(/if \(ticking\) return;/);
  });

  it("...and bails when the anchor has not actually moved", () => {
    const w = readCode("src/components/will/WillGuideOverlay.tsx");
    expect(w).toMatch(/lastRect/);
    expect(w).toMatch(/if \(same\) return;/);
  });

  it("the translator cannot re-trigger its own observer", () => {
    const d = readCode("src/components/DomTranslator.tsx");
    expect(d).toMatch(/if \(node\.nodeValue !== next\) node\.nodeValue = next;/);
  });

  it("scroll listeners that remain are passive", () => {
    for (const f of [
      "src/components/will/WillGuideOverlay.tsx",
      "src/components/useHeaderCollapse.ts",
    ]) {
      const src = readCode(f);
      if (!/addEventListener\("scroll"/.test(src)) continue;
      expect(src, `${f} scroll listener is not passive`).toMatch(/passive: true/);
    }
  });
});

describe("the bar's height cannot change, so nothing below it jumps", () => {
  it("the tagline truncates instead of wrapping", () => {
    const p = read("src/app/page.tsx");
    const bar = p.slice(p.indexOf('<div className="topbar">'));
    const row = bar.slice(0, bar.indexOf("</div>\n      </div>"));
    expect(row).toMatch(/truncate text-\[10px\]/);
    expect(row).toMatch(/min-w-0/);
    // ...and the controls cannot be squeezed into a second line.
    expect(row).toMatch(/shrink-0/);
  });

  it("NOTHING measures the bar at all any more", () => {
    // De-duping the republished height was not enough. `--topbar-h` lives on
    // documentElement and custom properties INHERIT, so any write invalidates
    // style for the whole document - and `.substick` parks at that value, so a
    // write MOVES the pinned sub-nav. On a phone `resize` fires continuously
    // while the URL bar collapses DURING a scroll gesture, which is exactly
    // when the jump was reported. The height is declared in CSS now, and the
    // measuring component is gone rather than tuned.
    expect(existsSync(join(process.cwd(), "src/components/TopbarMetrics.tsx"))).toBe(false);
    const all = [
      "src/app/layout.tsx",
      "src/app/page.tsx",
      "src/components/useHeaderCollapse.ts",
    ].map(readCode);
    for (const src of all) {
      expect(src).not.toMatch(/setProperty\("--topbar-h"/);
      expect(src).not.toMatch(/new ResizeObserver/);
    }
    expect(css()).toMatch(/--topbar-h:\s*calc\(var\(--safe-top\) \+ var\(--topbar-row-h\)\)/);
  });

  it("no infinite PAINT animation runs inside the sticky bar", () => {
    // `shine` animates background-position - paint, not composite - so an
    // infinite one inside a sticky layer repaints it every scroll frame.
    // Comment-stripped: the explanation of WHY names the old class.
    const p = readCode("src/app/page.tsx");
    const bar = p.slice(p.indexOf('<div className="topbar">'));
    // A fixed window over the bar's markup - the first "</div>" closes the
    // brand block, long before the plan pill.
    const row = bar.slice(0, 2200);
    expect(row).not.toMatch(/badge-ultra(?!-static)/);
    expect(row).toMatch(/badge-ultra-static/);
    const c = css();
    const staticBadge = c.slice(c.indexOf(".badge-ultra-static"));
    expect(staticBadge.slice(0, staticBadge.indexOf("}"))).not.toMatch(/animation/);
  });
});

describe("the collapse is transform-only", () => {
  it("animates transform and nothing that changes layout", () => {
    const c = css();
    const rule = c.slice(c.indexOf('.topbar[data-collapsed="true"]'));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/transform: translate3d/);
    // height/padding/max-height would change the measured height and feed the
    // ResizeObserver -> --topbar-h -> layout loop at scroll frequency.
    expect(body).not.toMatch(/height|padding|margin|top:/);
  });

  it("does no layout read and no React state PER FRAME", () => {
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/window\.scrollY/);
    expect(h).not.toMatch(/useState/);
    // The per-frame path is `read()`. It may touch scrollY and nothing that
    // forces layout; the one rect read lives in `apply()`, which runs on a
    // state FLIP - a couple of times per gesture, not sixty times a second.
    const perFrame = h.slice(h.indexOf("const read ="), h.indexOf("const onScroll ="));
    expect(perFrame.length).toBeGreaterThan(20);
    expect(perFrame).not.toMatch(/getBoundingClientRect|offsetHeight|offsetTop|getComputedStyle/);
  });

  it("the sub-nav travels with the bar, so no gap opens above it", () => {
    // Collapsing only the brand row left the pinned List/Map/Activity row
    // where it was, with ~55px of scrolling page visible above it. That window
    // of moving content under a stationary toggle is the "springy" report.
    const c = css();
    const rule = c.slice(c.indexOf('.topbar[data-collapsed="true"]'));
    const head = rule.slice(0, rule.indexOf("{"));
    expect(head).toMatch(/\.substick\[data-collapsed="true"\]/);
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/querySelectorAll<HTMLElement>\("\.topbar, \.substick"\)/);
  });

  it("...but never while it is still scrolling in flow", () => {
    // Translating an unpinned sub-nav would move it its whole offset in one
    // frame - the very jump this is meant to remove. The flip checks first.
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/const pinned =/);
    expect(h).toMatch(/if \(next && !pinned\)/);
  });

  it("promotes only while moving, never permanently", () => {
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/willChange = "transform"/);
    expect(h).toMatch(/willChange = ""/);
  });

  it("respects reduced motion", () => {
    expect(readCode("src/components/useHeaderCollapse.ts")).toMatch(
      /prefers-reduced-motion: reduce/
    );
    expect(css()).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.substick \{ transition: none/
    );
  });

  it("has hysteresis, so momentum and rubber-band do not flap it", () => {
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/HYSTERESIS_PX/);
    expect(h).toMatch(/ARM_PX/);
  });
});
