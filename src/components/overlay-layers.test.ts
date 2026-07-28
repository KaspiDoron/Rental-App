import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = () => read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

// The bottom navigation bar rendered ON TOP of the onboarding card and covered
// its primary button.
//
// The z-indexes said that was impossible: the card was 1300, the bar 50. But
// the card was the ONLY overlay in the app rendered inline, so its 1300 was
// 1300 among `.app-canvas`'s own children - and `.app-canvas` is a stacking
// context, because `page-fade` is an `animation ... both` and a fill-forwards
// opacity animation stays in effect forever. The canvas (z-auto) then painted
// before the portalled tab bar that follows it in the document.

describe("an overlay escapes the canvas", () => {
  it("onboarding portals to the body like every other overlay", () => {
    const o = read("src/components/Onboarding.tsx");
    expect(o).toMatch(/createPortal\(node, document\.body\)/);
    // All three render branches, not just the easy one.
    expect([...o.matchAll(/return overlay\(/g)]).toHaveLength(3);
  });

  it("...and is server-render safe", () => {
    expect(read("src/components/Onboarding.tsx")).toMatch(/typeof document === "undefined"/);
  });

  it("no overlay carries a hand-picked z-index any more", () => {
    expect(read("src/components/Onboarding.tsx")).not.toMatch(/z-\[1300\]/);
  });
});

describe("the layer ladder is named, not guessed", () => {
  it("every rung is a token", () => {
    const src = css();
    for (const t of ["--z-chrome", "--topbar-z", "--z-coach", "--z-overlay", "--z-veil", "--z-alert"]) {
      expect(src, `${t} missing`).toMatch(new RegExp(`${t}:\\s*\\d+`));
    }
  });

  it("the rungs are strictly ordered - chrome below overlays, always", () => {
    const src = css();
    const val = (t: string) => Number(src.match(new RegExp(`${t}:\\s*(\\d+)`))![1]);
    const chrome = val("--z-chrome");
    const topbar = val("--topbar-z");
    const coach = val("--z-coach");
    const overlay = val("--z-overlay");
    const veil = val("--z-veil");
    const alert = val("--z-alert");
    expect(chrome).toBeLessThan(topbar);
    expect(topbar).toBeLessThan(coach);
    // THE REGRESSION: a modal must beat the navigation bar, whatever else moves.
    expect(coach).toBeLessThan(overlay);
    expect(overlay).toBeLessThan(veil);
    expect(veil).toBeLessThan(alert);
  });

  it("there is a class per rung, so components state a layer not a number", () => {
    const src = css();
    for (const c of [".layer-chrome", ".layer-coach", ".layer-overlay", ".layer-veil", ".layer-alert"]) {
      expect(src).toContain(c);
    }
  });
});
