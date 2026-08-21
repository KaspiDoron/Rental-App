import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE FLOATING TAB BAR, ENDGAME (owner report 6 G).
//
// The owner photographed the bottom navigation rendered MID-SCREEN three
// times, at three different scroll positions. The audit found this is an
// equivalence class, not one bug: five historical mechanisms each violated
// one global invariant ("no ancestor of fixed chrome may create a containing
// block; html/body stay the scroll box"), and the LIVE mechanism was the
// keyboard formula - `innerHeight - (vv.height + vv.offsetTop)` sank below
// the threshold as iOS PANNED toward the focused field, so the bar UN-HID
// mid-keyboard, anchored to the layout viewport, at a pan-dependent height.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the keyboard formula (the live mechanism)", () => {
  const layer = read("src/components/FixedLayer.tsx");

  it("measures the RESIZE delta, scale-aware - never the pan", () => {
    expect(layer).toMatch(/window\.innerHeight - vv\.height \* \(vv\.scale \|\| 1\)/);
    // The pan-sensitive term is gone from the measurement.
    expect(layer).not.toMatch(/vv\.height \+ vv\.offsetTop/);
  });

  it("hides with hysteresis - once hidden, only a truly-gone inset un-hides", () => {
    expect(layer).toMatch(/KEYBOARD_CLEAR_PX = 10/);
    expect(layer).toMatch(/prev \? kb > KEYBOARD_CLEAR_PX : kb > KEYBOARD_MIN_PX/);
  });
});

describe("everything fixed goes through the layer", () => {
  it("the Ask-Will chip is portalled, not an inline fixed child of <main>", () => {
    const page = read("src/app/page.tsx");
    // The chip button carries no `fixed` of its own any more - its FixedLayer
    // host does. An inline fixed chip depended on no ancestor ever gaining a
    // transform, and hovered over panned content while the keyboard was up.
    expect(page).toMatch(/<FixedLayer[\s\S]{0,1400}data-tour="will"/);
  });

  it("StatusFab is portalled the same way", () => {
    const fab = read("src/components/StatusFab.tsx");
    expect(fab).toMatch(/<FixedLayer/);
    expect(fab).toMatch(/className="wd-status-fab rounded-full/); // no `fixed` on the button
  });

  it("swipe mode stands the bottom-right stack down", () => {
    const page = read("src/app/page.tsx");
    // Both the FAB mount and the chip's high slot test listAxis - the z-50
    // band used to paint over the rail cards' Bargain row for the whole
    // session in swipe mode.
    expect(page).toMatch(/view === "list" && listAxis !== "horizontal" && \(\s*<StatusFab/);
    expect(page).toMatch(/view === "list" && listAxis !== "horizontal"\s*\n?\s*\? "var\(--stack-bottom-2\)"/);
  });
});

describe("the teleport hardening", () => {
  it("scroll-lock nudges the fixed layers on both teleports", () => {
    const lock = read("src/lib/scroll-lock.ts");
    const pin = lock.indexOf('body.style.position = "fixed"');
    const restore = lock.indexOf("window.scrollTo(0, savedScrollY)");
    const first = lock.indexOf("nudgeFixedChrome()");
    const second = lock.indexOf("nudgeFixedChrome()", first + 1);
    expect(first).toBeGreaterThan(pin);
    expect(second).toBeGreaterThan(restore);
    expect(lock).toMatch(/nudgeFixedLayers\(\)/);
  });

  it("FixedLayer exports the nudge and subscribes its beat to it", () => {
    const layer = read("src/components/FixedLayer.tsx");
    expect(layer).toMatch(/export function nudgeFixedLayers/);
    expect(layer).toMatch(/nudgeSubs\.add\(nudge\)/);
    expect(layer).toMatch(/nudgeSubs\.delete\(nudge\)/);
  });

  it("a dev sentinel names the next invariant violator", () => {
    const layer = read("src/components/FixedLayer.tsx");
    // Runtime style injection (an ads script, an extension) is invisible to
    // every source-level test in this repo - the sentinel is the only witness.
    expect(layer).toMatch(/overflowX !== "visible"/);
    expect(layer).toMatch(/body\.transform !== "none"/);
  });
});
