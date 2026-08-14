import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { AURORA, aurora } from "./aurora";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const css = readRaw("src/app/globals.css");
const skeleton = stripComments(readRaw("src/components/Skeleton.tsx"));
const veil = stripComments(readRaw("src/components/NavVeil.tsx"));
const pulse = stripComments(readRaw("src/components/BrandPulse.tsx"));

// "THE SPECIAL LOADING THAT GLOWING LOOK VERY BAD."
//
// The owner named the geometry precisely: it reads as "a rounded square that
// turns 360 degrees". It did, and it had to. The old animation was
//
//     @keyframes aurora-drift { to { transform: rotate(1turn); } }
//
// applied to the pseudo-element itself. Rotating a NON-SQUARE box about its
// centre sweeps its corners in and out of the rounded mask, so on any card
// wider than it is tall - every card - the eye tracks a spinning box rather
// than travelling light. On the masked rim it is worse: the mask does not
// rotate with the element, so the rim's corners scrape across it.
//
// Three more defects rode along:
//
//   - the five gradient stops were hardcoded rgba() literals with no
//     relationship to any brand token, so the glow read as generic AI shimmer;
//   - they interpolated in sRGB, which drives blue->green through GREY - the
//     muddy band visible halfway round;
//   - `aurora-breathe` animated `opacity`, which outranks both the static value
//     and the dark-mode override, so the one adjustment that made this readable
//     in daylight was silently cancelled by the breath.
//
// And the coverage complaint was the largest of all: the glow existed at TWO of
// roughly seventy loading surfaces.
//
// This file used to pin the shape those defects had. It pins the fixes now.

describe("REGRESSION: the geometry - no spin, no blur, ambient's own language", () => {
  const block = css.slice(css.indexOf(".aurora {"), css.indexOf(".no-scrollbar"));
  // COMMENTS STRIPPED. The block explains the old defects in prose, and the
  // first draft of this assertion matched its own documentation - a test that
  // fails on a correct fix because the fix is described.
  const rules = stripComments(block);

  it("nothing in the glow is rotated by a transform any more", () => {
    expect(rules, "rotating a non-square masked box is the whole defect").not.toMatch(
      /transform:\s*rotate/
    );
    expect(stripComments(css)).not.toMatch(/@keyframes aurora-drift/);
  });

  it("the rainbow sweep is gone - the glow is a SINGLE hue in oklch lightness", () => {
    // Loading v3: v2 replaced the conic rainbow with FIVE radial hues, but at
    // box scale five hues still read as the colour wheel the owner named "the
    // worst thing that I ever seen". The bloom is now ONE brand hue walked
    // across oklch lightness - never rotating, never a colour wheel.
    expect(stripComments(css)).not.toMatch(/@keyframes wd-hue-sweep/);
    expect(stripComments(css)).not.toMatch(/@property --wd-hue-angle/);
    const before = rules.slice(rules.indexOf(".aurora::before"), rules.indexOf(".aurora::after"));
    expect(before).not.toMatch(/conic-gradient/);
    // Radial lobes, yes - but the ONLY brand hue in them is --wd-hue-1. A
    // second hue (2/3/4/5) appearing would be the wheel coming back.
    expect(before).toMatch(/radial-gradient\(/);
    expect(before).toMatch(/var\(--wd-hue-1\)/);
    expect(before, "the loader bloom must not stack a second hue").not.toMatch(/--wd-hue-[2345]/);
    expect(before).toMatch(/color-mix\(in oklch/);
    expect(before).toMatch(/animation: aurora-breathe/);
  });

  it("no blur pass on the bloom - the same low-end-Android rule the ambient lives by", () => {
    const before = rules.slice(rules.indexOf(".aurora::before"), rules.indexOf(".aurora::after"));
    expect(before, "soft gradient stops carry the haze for free").not.toMatch(/filter:/);
  });

  it("the rim is a still jewel setting - masked ring, no animation of its own", () => {
    const after = rules.slice(rules.indexOf(".aurora::after"));
    expect(after).toMatch(/mask-composite: exclude/);
    expect(after).toMatch(/linear-gradient\(\s*\n?\s*135deg/);
    expect(after.slice(0, after.indexOf("\n}"))).not.toMatch(/animation:/);
  });
});

describe("REGRESSION: the palette is the brand's, and it does not go grey", () => {
  it("no gradient stop is a hardcoded rgb colour - every stop resolves from the one hue", () => {
    const block = css.slice(css.indexOf(".aurora::before"), css.indexOf("@keyframes aurora-breathe"));
    const clean = stripComments(block);
    expect(
      clean,
      "a stop that cannot follow the theme is a stop that does not belong to the brand"
    ).not.toMatch(/rgba?\(/);
    // Single hue now: every brand-colour stop in the bloom AND the rim is
    // --wd-hue-1 (mixed toward #fff/#000 for the lightness ramp). No other hue
    // appears - that is the whole point of ditching the wheel.
    const stops = clean.match(/var\(--wd-hue-\d\)/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(4);
    expect(stops.every((s) => s === "var(--wd-hue-1)"), "the loader glow is one hue").toBe(true);
  });

  it("the hue set is seeded from real brand tokens", () => {
    for (const token of ["--blue", "--wa-green", "--yellow", "--red"]) {
      expect(css, token).toMatch(new RegExp(`--wd-hue-\\d: color-mix\\(in oklch, var\\(${token}\\)`));
    }
  });

  it("mixing happens in oklch - sRGB is what made the midpoints muddy", () => {
    const defs = css.slice(css.indexOf("--wd-hue-1:"), css.indexOf("--wd-hue-5:") + 120);
    const mixes = defs.match(/color-mix\(in (\w+)/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const m of mixes) expect(m).toBe("color-mix(in oklch");
  });

  it("one held violet keeps it an aurora rather than a traffic light", () => {
    expect(css).toMatch(/--wd-hue-2: #7c5cff/);
  });
});

describe("REGRESSION: opacity belongs to the theme again", () => {
  it("the breath no longer animates opacity", () => {
    const kf = css.slice(css.indexOf("@keyframes aurora-breathe"));
    const body = kf.slice(0, kf.indexOf("}", kf.indexOf("50%")) + 1);
    expect(
      body,
      "an animated opacity outranks both the static value and the dark override"
    ).not.toMatch(/opacity/);
    expect(body).toMatch(/scale/);
  });

  it("so the dark-mode overrides can actually win", () => {
    // One selector per rule: `data-theme` is the single theme switch now -
    // the dead `html.dark` halves were deleted with the 2.1 activation
    // (nothing ever set that class).
    expect(css).toMatch(/\[data-theme="dark"\] \.aurora::before \{ opacity: 0\.62; \}/);
    expect(css).toMatch(/\[data-theme="dark"\] \.aurora::after \{ opacity: 0\.75; \}/);
    expect(css).not.toMatch(/html\.dark/);
  });
});

describe("the loader mark holds still - no scale-pulse, no draw-on", () => {
  it("the heartbeat and the draw-on are GONE from the stylesheet", () => {
    // Loading v3 inverts the v2 pins. A scaling logo is the single most dated
    // loading element and precisely what prefers-reduced-motion exists to
    // remove; the owner named it, and the outline sketch it rode on, as "the
    // worst thing that I ever seen". Neither may come back.
    const clean = stripComments(css);
    expect(clean).not.toMatch(/@keyframes wd-heartbeat/);
    expect(clean).not.toMatch(/\.wd-heartbeat/);
    expect(clean).not.toMatch(/@keyframes wd-draw-on/);
    expect(clean).not.toMatch(/\.wd-draw/);
  });

  it("the mark the loader renders does not animate its own transform", () => {
    // BrandPulse renders the REAL solid BrandMark, motionless - no wd-heartbeat,
    // no outline variant, no wrapper glow. The old pins asserted the PRESENCE of
    // a scale-pulse; these assert its ABSENCE.
    expect(pulse).toMatch(/import \{ BrandMark \}/);
    expect(pulse).toMatch(/<BrandMark size=\{size\}/);
    expect(pulse).not.toMatch(/wd-heartbeat/);
    expect(pulse).not.toMatch(/variant="outline"/);
    expect(pulse).not.toMatch(/\baurora\b/);
    // The solid mark is the ONLY variant now - the hated outline was deleted
    // outright, taking its currentColor strokes and wd-draw class with it.
    const mark = stripComments(readRaw("src/components/BrandMark.tsx"));
    expect(mark).not.toMatch(/variant/);
    expect(mark).not.toMatch(/wd-draw/);
    expect(mark).not.toMatch(/stroke="currentColor"/);
  });

  it("the loader's WHOLE motion is the single-hue horizon line", () => {
    // A thin bar under the still mark, one bright specular segment gliding
    // across - one hue in oklch lightness, no colour wheel, no rotation.
    expect(pulse).toMatch(/wd-horizon/);
    expect(css).toMatch(/@keyframes wd-horizon-travel/);
    const horizon = css.slice(css.indexOf(".wd-horizon {"), css.indexOf(".wd-loader-veil"));
    expect(horizon).toMatch(/var\(--wd-hue-1\)/);
    expect(horizon, "the horizon is one hue, not a wheel").not.toMatch(/--wd-hue-[2345]/);
    expect(horizon).toMatch(/color-mix\(in oklch/);
    expect(horizon).toMatch(/animation: wd-horizon-travel/);
    expect(horizon, "the glint translates - nothing rotates").not.toMatch(/rotate/);
  });

  it("~1.6s ease-in-out - a calm glide, not an anxious sweep", () => {
    const dur = /animation: wd-horizon-travel ([\d.]+)s ease-in-out/.exec(css)?.[1];
    expect(Number(dur)).toBeGreaterThanOrEqual(1.2);
    expect(Number(dur)).toBeLessThanOrEqual(2);
  });

  it("the loader still rides the (now lightened) veil", () => {
    expect(css).toMatch(/\.wd-loader-veil \{/);
    expect(css).toMatch(/backdrop-filter: blur\(/);
    expect(pulse).toMatch(/wd-loader-veil/);
  });

  it("no animation library was added for it", () => {
    // Motion is ~12 KB gz and Framer Motion ~31 KB; every effect here is a
    // keyframe over an SVG already in the bundle.
    const pkg = JSON.parse(readRaw("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ["framer-motion", "motion", "gsap", "react-spring", "@react-spring/web", "lottie-react"]) {
      expect(all[banned], `${banned} must not be a dependency`).toBeUndefined();
    }
    expect(pulse).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
  });
});

describe("COVERAGE: the complaint was that it is not everywhere", () => {
  it("the search screen shows the still loader - it used to show nothing", () => {
    const page = stripComments(readRaw("src/app/page.tsx"));
    expect(page).toMatch(/<BrandPulse size=\{62\}/);
    expect(page).toMatch(/phase === "profiling"/);
  });

  it("the nav veil shows the SAME loader, so a route change reads like a search", () => {
    // One step further than the original claim: NavVeil now renders the exact
    // BrandPulseVeil component the route loading.tsx files use (which itself
    // carries wd-loader-veil), so the vocabularies cannot fork again.
    expect(veil).toMatch(/<BrandPulseVeil/);
    // The old flat black scrim + orbiting dots was a second loading vocabulary.
    expect(veil).not.toMatch(/bg-black\/35/);
    expect(veil).not.toMatch(/OrbitDots/);
  });

  it("no bare border spinner survives anywhere", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const offenders = walk("src").filter((f) =>
      /animate-spin[^"]*rounded-full[^"]*border/.test(readRaw(f))
    );
    expect(
      offenders,
      `a rotating half-border is a different vocabulary for the same sentence:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("inline dots join by ONE hue in a lightness ramp, not three distinct hues", () => {
    // ~60 sites. Sixty conic gradients under an 18px blur is a repaint budget,
    // not a design - they join by colour. But v2 gave each dot a DIFFERENT brand
    // hue (--wd-hue-1/2/3), the same rainbow tell as the old wheel. Loading v3:
    // one hue (--wd-hue-1) walked across three oklch lightness steps.
    const dots = stripComments(readRaw("src/components/LoadingDots.tsx"));
    expect(dots).toMatch(/--wd-hue-1/);
    expect(dots, "one hue, not a wheel").not.toMatch(/--wd-hue-[2345]/);
    expect(dots).toMatch(/color-mix\(in oklch/);
    expect(dots).not.toMatch(/aurora/);
  });
});

describe("PERFORMANCE: at most one full-glow element on a screen", () => {
  it("a skeleton LIST still glows only its leading card", () => {
    expect(skeleton).toMatch(/glow=\{i === 0\}/);
  });

  it("the search screen's four skeleton cards carry the cheap shimmer only", () => {
    const page = readRaw("src/app/page.tsx");
    // Bound on the next top-level sibling rather than on a brace/indent shape,
    // which changed the moment the block was re-nested.
    const start = page.indexOf('phase === "profiling"');
    const body = page.slice(start, page.indexOf("<AdBanner", start));
    // One BrandPulse, and no `aurora` on the cards beneath it.
    expect((body.match(/<BrandPulse/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/className="[^"]*\baurora\b/);
  });
});

describe("the glow still has exactly one name and one definition", () => {
  it("the class is a constant, not a literal typed per component", () => {
    expect(AURORA).toBe("aurora");
    expect(aurora(true)).toBe("aurora");
    expect(aurora(false)).toBe("");
    expect(aurora()).toBe("aurora");
  });

  it("Skeleton imports the constant rather than hardcoding it", () => {
    expect(skeleton).toMatch(/from "\.\.\/lib\/aurora"/);
    expect(skeleton).not.toMatch(/"aurora"|'aurora'/);
  });

  it("the class exists once in the CSS", () => {
    expect((css.match(/^\.aurora \{/gm) ?? []).length).toBe(1);
  });

  it("no parallel loading component was created", () => {
    const names = readdirSync(join(process.cwd(), "src/components"));
    expect(names.filter((n) => /^Aurora/i.test(n))).toEqual([]);
  });

  it("OrbitDots stays glow-free - a primitive that needs its glow is not one", () => {
    expect(readRaw("src/components/OrbitDots.tsx")).not.toMatch(/aurora/i);
  });

  it("it is pure CSS - no JS drives any of it", () => {
    expect(readRaw("src/lib/aurora.ts")).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
  });

  it("the bloom sits behind the content and never eats a tap", () => {
    const block = css.slice(css.indexOf(".aurora::before"), css.indexOf(".aurora::after"));
    expect(block).toMatch(/z-index: -1/);
    expect(block).toMatch(/pointer-events: none/);
    const after = css.slice(css.indexOf(".aurora::after"));
    expect(after.slice(0, 900)).toMatch(/pointer-events: none/);
  });

  it("the edge is masked to the border, so a rounded card gets no double rim", () => {
    const after = css.slice(css.indexOf(".aurora::after"));
    expect(after.slice(0, 1100)).toMatch(/mask-composite: exclude/);
    expect(after.slice(0, 1100)).toMatch(/border-radius: inherit/);
  });
});

describe("reduced motion keeps the colour and drops every movement", () => {
  it("including the horizon glint - a moving light is exactly what that setting is for", () => {
    // There is more than one prefers-reduced-motion block in this stylesheet
    // (the topbar has its own). Search from the aurora definition forward, or
    // this asserts against a block that was never about the glow.
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".aurora {"))
    );
    const body = reduced.slice(0, reduced.indexOf("\n}") + 2);
    expect(body).toMatch(/\.aurora::before,\s*\n\s*\.aurora::after \{ animation: none; \}/);
    expect(body).toMatch(/opacity: 0\.4/);
    // The horizon holds a still, single-hue bar instead of a parked glint -
    // keeps the colour, drops the travel (the mark was already motionless).
    expect(body).toMatch(/\.wd-horizon::after \{/);
    expect(body).toMatch(/animation: none/);
  });
});

describe("the skeleton shimmer sweep is alive again", () => {
  it("@keyframes shimmer is declared in the stylesheet, not only in the tailwind config", () => {
    // The keyframe lived ONLY in tailwind.config.ts, where Tailwind tree-shook
    // it away (no `animate-shimmer` utility was ever emitted), so
    // `.skeleton::after`'s `animation: shimmer` pointed at a keyframe that never
    // shipped - every skeleton was a flat opacity breath. It is declared in the
    // CSS now, next to its consumer, sweeping the -100% start to +100%.
    expect(css).toMatch(/@keyframes shimmer \{\s*\n?\s*to \{ transform: translateX\(100%\); \}/);
    expect(css).toMatch(/\.skeleton::after \{[\s\S]*?animation: shimmer/);
  });
});
