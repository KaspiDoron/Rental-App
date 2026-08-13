import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// DARK THEME ACTIVATION (owner report 3, item 1).
//
// The dark theme largely EXISTED - [data-theme="dark"] token blocks, a
// Profile control, a prehydrate script - and still the owner's phone showed a
// white Find-deals screen inside an otherwise dark app. The failures were all
// wiring: tailwind's `dark:` utilities keyed on the OS while the tokens keyed
// on the attribute (split-brain), the `warn` color classes compiled to
// nothing, the prehydrate could be skipped whole by a storage exception, and
// no toggle was reachable outside Profile. These pins hold the wiring.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("one switch drives both theme systems", () => {
  it("tailwind dark: utilities key on data-theme, not the OS", () => {
    expect(read("tailwind.config.ts")).toMatch(
      /darkMode: \["selector", '\[data-theme="dark"\]'\]/
    );
  });

  it("the warn color exists everywhere its classes are already used", () => {
    expect(read("tailwind.config.ts")).toMatch(
      /warn: \{ DEFAULT: "var\(--warn\)", soft: "var\(--warn-soft\)" \}/
    );
    const css = read("src/app/globals.css");
    // Once per theme surface: light root, dark attribute, dark media fallback.
    expect(css.match(/--warn:/g)?.length).toBe(3);
    expect(css.match(/--warn-soft:/g)?.length).toBe(3);
  });

  it("the hand-rolled amber pair is gone from the components", () => {
    // 60+ occurrences of `text-[#8a6100] dark:text-brandyellow` became
    // text-warn. The one survivor (WabaConsole) sits on SOLID bg-brandyellow
    // where the dark warn yellow would vanish - deliberate, and bounded to 1.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      `grep -rc 'dark:text-brandyellow' src --include='*.tsx' | grep -v ':0' || true`,
      { cwd: process.cwd(), encoding: "utf8" }
    ).trim();
    expect(hits).toBe("");
  });

  it("native widgets follow the app theme (color-scheme on both blocks)", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/color-scheme: light;/);
    expect(css.match(/color-scheme: dark;/g)?.length).toBe(2);
  });

  it("the no-JS media fallback mirrors the dark block EXACTLY", () => {
    const css = read("src/app/globals.css");
    const decls = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
      );
    const darkStart = css.indexOf('[data-theme="dark"] {');
    const darkBlock = css.slice(darkStart, css.indexOf("}", darkStart));
    const mediaStart = css.indexOf(":root:not([data-theme]) {");
    const mediaBlock = css.slice(mediaStart, css.indexOf("}", mediaStart));
    expect(mediaStart).toBeGreaterThan(-1);
    expect(decls(mediaBlock)).toEqual(decls(darkBlock));
  });

  it("nothing selects the html.dark class nothing ever sets", () => {
    expect(read("src/app/globals.css")).not.toMatch(/html\.dark/);
  });
});

describe("the prehydrate survives a blocked localStorage", () => {
  const layout = read("src/app/layout.tsx");

  it("the storage read is isolated; the stamp always runs", () => {
    // One shared try/catch made a storage exception skip the attribute
    // entirely - a dark-OS private-mode visitor landed on the light theme.
    expect(layout).toMatch(/var t = null;\s*\n\s*try \{ t = localStorage\.getItem\("wd_theme"\); \} catch \(e\) \{\}/);
    expect(layout).toMatch(/if \(t !== "dark" && t !== "light"\)/);
    expect(layout).toMatch(/prefers-color-scheme: dark/);
    expect(layout).toMatch(/setAttribute\("data-theme", t\)/);
  });
});

describe("every control changes the theme through the one lib", () => {
  it("ThemeToggle and Profile both call applyTheme", () => {
    expect(read("src/components/ThemeToggle.tsx")).toMatch(
      /import \{ readTheme, applyTheme, type Theme \} from "@\/lib\/client\/theme"/
    );
    const profile = read("src/app/profile/page.tsx");
    expect(profile).toMatch(/import \{ readTheme, applyTheme \} from "@\/lib\/client\/theme"/);
    expect(profile).toMatch(/applyTheme\(t2\);/);
    // The old inline implementation is gone.
    expect(profile).not.toMatch(/localStorage\.setItem\("wd_theme"/);
  });

  it("applyTheme repaints the live theme-color meta", () => {
    const lib = read("src/lib/client/theme.ts");
    expect(lib).toMatch(/meta\[name="theme-color"\]/);
    // The two colors mirror the --bg tokens.
    expect(lib).toMatch(/#f4f6f9/);
    expect(lib).toMatch(/#17191d/);
  });

  it("the toggle is in every topbar, beside the language chip", () => {
    for (const p of [
      "src/app/page.tsx",
      "src/app/deals/page.tsx",
      "src/app/profile/page.tsx",
      "src/app/admin/page.tsx",
      "src/app/login/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/<ThemeToggle \/>/);
    }
  });
});

describe("the map follows the theme", () => {
  it("dark cartography is keyed on the live theme", () => {
    const map = read("src/components/MapView.tsx");
    expect(map).toMatch(/useAppTheme\(\)/);
    expect(map).toMatch(/key=\{theme\}/);
    expect(map).toMatch(/basemaps\.cartocdn\.com\/dark_all/);
  });

  it("the canvas behind the tiles and the attribution follow too", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\[data-theme="dark"\] \.leaflet-container \{ background: #17191d !important; \}/);
    expect(css).toMatch(/\[data-theme="dark"\] \.leaflet-control-attribution \{/);
  });
});
