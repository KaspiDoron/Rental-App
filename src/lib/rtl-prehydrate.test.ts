import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// I-6c: RTL WAS DECLARED AND APPLIED TOO LATE.
//
// `dir` was set only by the i18n provider's effect, which runs after hydration -
// so a Hebrew or Arabic cold load painted left-to-right and then snapped to RTL
// on the first frame. The fix stamps dir/lang on <html> in the pre-paint theme
// script, and turns the bare arrow glyphs into mirrorable spans.

describe("dir is set before first paint, not after hydration", () => {
  const layout = read("src/app/layout.tsx");

  it("the pre-paint script reads wd_lang and stamps dir on the root", () => {
    expect(layout).toMatch(/localStorage\.getItem\("wd_lang"\)/);
    expect(layout).toMatch(/setAttribute\("dir",/);
    expect(layout).toMatch(/setAttribute\("lang", l\)/);
  });

  it("it runs INSIDE the script that already applies the theme, before hydration", () => {
    // Same dangerouslySetInnerHTML block that stamps data-theme - so it runs in
    // <head> before the body paints, which is the whole point.
    const scriptStart = layout.indexOf("const themeScript");
    const wdLang = layout.indexOf('localStorage.getItem("wd_lang")');
    const injected = layout.indexOf("dangerouslySetInnerHTML={{ __html: themeScript }}");
    expect(wdLang).toBeGreaterThan(scriptStart);
    expect(wdLang).toBeLessThan(injected);
  });

  it("the inlined RTL set matches LANGS' rtl:true entries exactly", () => {
    // The script cannot import LANGS (it runs before modules load), so the
    // literal must stay in sync. This test is that sync check.
    const i18n = read("src/lib/i18n.tsx");
    const rtlCodes = [...i18n.matchAll(/code:\s*"([a-z]{2})"[^}]*rtl:\s*true/g)].map((m) => m[1]).sort();
    expect(rtlCodes).toEqual(["ar", "he"]);
    // Every one of those codes appears in the pre-paint comparison.
    for (const code of rtlCodes) {
      expect(layout).toMatch(new RegExp(`l === "${code}"`));
    }
    // And no OTHER two-letter code is hard-coded as rtl in the script.
    const scriptRtl = [...layout.matchAll(/l === "([a-z]{2})"/g)].map((m) => m[1]).sort();
    expect(scriptRtl).toEqual(["ar", "he"]);
  });
});

describe("the wizard arrows can mirror", () => {
  const rb = read("src/components/RequestBuilder.tsx");

  it("Back and Next arrows are mirrorable spans, not bare glyphs", () => {
    // A bare "←" is a fixed glyph: in RTL the Back button then points the way
    // Next should. `.rtl-flip` mirrors the span under [dir="rtl"].
    expect(rb).toMatch(/<span className="rtl-flip inline-block" aria-hidden>←<\/span> \{t\("Back"\)\}/);
    expect(rb).toMatch(/\{t\("Next"\)\} <span className="rtl-flip inline-block" aria-hidden>→<\/span>/);
  });

  it("no bare arrow glyph remains glued to a translated label", () => {
    // The exact defect: `← {t("Back")}` / `{t("Next")} →` as bare text nodes.
    expect(rb).not.toMatch(/(^|[^>])← \{t\("Back"\)\}/);
    expect(rb).not.toMatch(/\{t\("Next"\)\} →(?!<)/);
  });

  it(".rtl-flip is defined and applies a horizontal mirror", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\[dir="rtl"\] \.rtl-flip \{\s*transform: scaleX\(-1\);/);
  });
});
