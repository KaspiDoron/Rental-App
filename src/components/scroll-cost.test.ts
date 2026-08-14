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
  it("the fixed layer does no React work on a plain scroll", () => {
    // The claim EVOLVED with the keyboard fix. The layer now listens to
    // visualViewport scroll - it must, because iOS pans the visual viewport
    // while the keyboard is open and `offsetTop` (half the inset math) changes
    // on those pans without a resize. What is still forbidden is the original
    // sin: unconditional setState per scroll frame. The listener is rAF
    // throttled and its setState bails when the inset has not moved, so a
    // plain no-keyboard scroll re-renders nothing.
    const f = readCode("src/components/FixedLayer.tsx");
    expect(f).toMatch(/addEventListener\("scroll", onVvScroll/);
    expect(f).toMatch(/if \(raf\) return;/);
    expect(f).toMatch(/Math\.abs\(prev - kb\) < 1 \? prev : kb/);
    // The beat-bumper must never ride the scroll event - that combination is
    // the exact per-frame recalc this suite was written against.
    expect(f).not.toMatch(/addEventListener\("scroll", nudge/);
    expect(f).toMatch(/addEventListener\("resize"/);
    expect(f).toMatch(/orientationchange/);
  });

  it("the fixed layer answers the keyboard by MOVING, not by a recalc ritual", () => {
    const f = readCode("src/components/FixedLayer.tsx");
    // The old defence bumped a `data-beat` attribute no CSS selected - a style
    // recalculation that repositioned nothing, which is why the mid-screen bar
    // came back on a real phone. Hidden chrome is chrome that cannot float.
    expect(f).not.toMatch(/data-beat/);
    expect(f).toMatch(/translateY\(120%\)/);
    expect(f).toMatch(/KEYBOARD_MIN_PX/);
    // And the engines with no visualViewport still get an answer.
    expect(f).toMatch(/focusin/);
    expect(f).toMatch(/focusout/);
  });

  it("no component locks the body by hand", () => {
    // scroll-lock.ts exists because flipping `body.overflow` on a scrolled
    // page is the documented WebKit trigger for fixed chrome compositing mid
    // screen. FirstTouchTerms mounts on EVERY page and carried its own toggle.
    const files = [
      "src/components/FirstTouchTerms.tsx",
      "src/components/Modal.tsx",
      "src/components/MapView.tsx",
      "src/components/ThreadDashboard.tsx",
    ];
    for (const p of files) {
      expect(readCode(p), `${p} sets body.style.overflow by hand`).not.toMatch(
        /body\.style\.overflow\s*=/
      );
    }
    expect(readCode("src/components/FirstTouchTerms.tsx")).toMatch(/lockBodyScroll\(\)/);
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

  it("REPRODUCTION: the whole-DOM translator is gone, not merely throttled", () => {
    // This test used to pin a guard INSIDE DomTranslator: don't write nodeValue
    // unless it changed, so the observer cannot re-trigger itself. That guard
    // was real and it fixed the 400ms scroll loop.
    //
    // But the component was unsalvageable for a different reason. It walked the
    // entire document.body and POSTed every text node to /api/translate, which
    // caches into app_config.I18N_<lang> - ONE GLOBALLY SHARED ROW. Its only
    // safety mechanism, `data-no-translate`, was applied to ZERO elements in the
    // app (the attribute appeared 3 times, all inside DomTranslator's own
    // source), so WhatsApp transcripts and shop names from one traveller were
    // uploaded and then served to every other user in that language.
    //
    // A component that cannot be made safe by configuration is deleted, not
    // tuned. I18N_CATALOG already covers every t() string, so the static UI is
    // translated without it.
    expect(existsSync(join(process.cwd(), "src/components/DomTranslator.tsx"))).toBe(false);
    const layout = readCode("src/app/layout.tsx");
    expect(layout).not.toMatch(/DomTranslator/);
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

  it("the views bar scrolls off in flow - it is not pinned and does not collapse", () => {
    // The owner's report: the List/Map/Activity + Feed/Swipe bar pinned below
    // the top bar and blocked the screen. It is now a normal in-flow element,
    // so it must be OUT of the collapse machinery entirely: not in the transform
    // selector, and not managed by the collapse hook (which now moves only the
    // top brand row). The pinned-vs-in-flow rect read goes with it.
    const c = css();
    expect(c).not.toMatch(/\.substick\[data-collapsed="true"\]/);
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/querySelectorAll<HTMLElement>\("\.topbar"\)/);
    expect(h).not.toMatch(/\.substick/);
    expect(h).not.toMatch(/const pinned =/);
    expect(h).not.toMatch(/getBoundingClientRect/);
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
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.topbar \{ transition: none/
    );
  });

  it("has hysteresis, so momentum and rubber-band do not flap it", () => {
    const h = readCode("src/components/useHeaderCollapse.ts");
    expect(h).toMatch(/HYSTERESIS_PX/);
    expect(h).toMatch(/ARM_PX/);
  });
});
