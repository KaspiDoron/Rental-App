import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const css = readRaw("src/app/globals.css");
const skeleton = stripComments(readRaw("src/components/Skeleton.tsx"));
const veil = stripComments(readRaw("src/components/NavVeil.tsx"));
const pulse = stripComments(readRaw("src/components/BrandPulse.tsx"));
const dots = stripComments(readRaw("src/components/LoadingDots.tsx"));

// THE LOADING CHROME IS COLOURLESS. THE PAGE BEHIND IT IS NOT.
//
// This file was `aurora.test.ts`, and it pinned the shape of a coloured glow
// worn by the loading primitives - first a conic rainbow, then five radial
// hues, then one brand hue in an oklch lightness ramp. Each round was the
// owner asking for less colour on the chrome, and the last round ended it:
// remove the blue from the loading components completely, build the skeletons
// from the greys of the background, and put every colour into the ambient wash
// behind the app instead.
//
// So the glow is deleted - class, helper module, prop and all - and this file
// now guards the ARRANGEMENT rather than the effect:
//
//   1. nothing in the loading chrome references a brand hue;
//   2. the deleted glow does not come back under any name;
//   3. everything that was TRUE of the old chrome and should stay true - one
//      loading vocabulary, no spinners, no animation library, no JS timers,
//      a motionless mark, honest reduced-motion - still holds.
//
// Renamed rather than left as aurora.test.ts: a file's name should say what it
// protects, and what it protects now is the chrome, not the glow.

describe("THE GLOW IS GONE, AND STAYS GONE", () => {
  const clean = stripComments(css);

  it("no .aurora rule, keyframe or helper survives anywhere", () => {
    expect(clean, ".aurora must not be redefined").not.toMatch(/\.aurora\b/);
    expect(clean).not.toMatch(/@keyframes aurora-/);
    // The old defects, still forbidden - a rewrite must not reintroduce the
    // shapes that got the effect deleted in the first place.
    expect(clean).not.toMatch(/@keyframes aurora-drift/);
    expect(clean).not.toMatch(/@keyframes wd-hue-sweep/);
    expect(clean).not.toMatch(/@property --wd-hue-angle/);
    expect(clean).not.toMatch(/conic-gradient/);
  });

  it("the helper module is deleted, not merely unused", () => {
    // A module nobody imports is a module someone re-imports six months later.
    expect(() => readRaw("src/lib/aurora.ts")).toThrow();
    expect(skeleton, "Skeleton must not import the dead helper").not.toMatch(/lib\/aurora/);
    expect(skeleton).not.toMatch(/\baurora\(/);
  });

  it("the glow prop is gone from the skeleton API rather than left as a no-op", () => {
    // A prop that silently does nothing is worse than a compile error at the
    // call site: it reads as a working switch to everyone after you.
    expect(skeleton).not.toMatch(/glow\s*[?:=]/);
    expect(skeleton).not.toMatch(/glow=\{/);
  });

  it("no parallel glow component appears under a new name", () => {
    const names = readdirSync(join(process.cwd(), "src/components"));
    expect(names.filter((n) => /^(Aurora|Glow|Halo|Shine)/i.test(n))).toEqual([]);
  });
});

describe("NO BRAND HUE TOUCHES A LOADING COMPONENT", () => {
  // The single rule this whole redesign rests on. The hue tokens are the
  // AMBIENT's; the chrome draws from the neutral --wd-skel-*/--wd-load-* set.
  const block = (re: RegExp) => {
    const m = re.exec(css);
    expect(m, `${re} moved`).toBeTruthy();
    return stripComments(m![0]);
  };

  it("the skeleton plate and its sheen are pure neutrals", () => {
    const plate = block(/\.skeleton \{[\s\S]*?\n\}/);
    const sheen = block(/\.skeleton::after \{[\s\S]*?\n\}/);
    for (const b of [plate, sheen]) {
      expect(b).not.toMatch(/--wd-hue-/);
      expect(b, "no raw brand colour token either").not.toMatch(/var\(--(blue|red|yellow|wa-green)\b/);
    }
    // ...and they are built from the background greys the owner named.
    expect(plate).toMatch(/var\(--wd-skel-base\)/);
    expect(sheen).toMatch(/var\(--wd-skel-sheen\)/);
  });

  it("the horizon rail and its glint are pure neutrals", () => {
    const rail = block(/\.wd-horizon \{[\s\S]*?\n\}/);
    const glint = block(/\.wd-horizon::after \{[\s\S]*?\n\}/);
    for (const b of [rail, glint]) {
      expect(b).not.toMatch(/--wd-hue-/);
      expect(b).not.toMatch(/var\(--(blue|red|yellow|wa-green)\b/);
    }
    expect(rail).toMatch(/var\(--wd-load-track\)/);
    expect(glint).toMatch(/var\(--wd-load-sheen\)/);
  });

  it("the inline dots are a NEUTRAL lightness ramp - one material, three steps", () => {
    // ~60 sites. They still join by colour rather than each inventing its own
    // treatment; the colour is simply no longer a colour.
    expect(dots).not.toMatch(/--wd-hue-/);
    expect(dots).toMatch(/--wd-load-ink/);
    expect(dots).toMatch(/color-mix\(in oklch/);
    expect(dots).not.toMatch(/aurora/);
  });

  it("every neutral token is defined in BOTH theme blocks", () => {
    // A loader token that only exists in light mode is an invisible loader in
    // dark mode - the exact failure the skeleton shimmer shipped with once.
    const tokens = [
      "--wd-skel-base",
      "--wd-skel-grade",
      "--wd-skel-edge",
      "--wd-skel-sheen",
      "--wd-load-track",
      "--wd-load-sheen",
      "--wd-load-ink",
    ];
    const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
    const darkBlock = dark.slice(0, dark.indexOf("\n}"));
    const sys = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    const sysBlock = sys.slice(0, sys.indexOf("\n  }"));
    for (const t of tokens) {
      expect(css, `${t} missing from :root`).toMatch(new RegExp(`^\\s*${t}:`, "m"));
      expect(darkBlock, `${t} missing from the dark block`).toContain(t);
      expect(sysBlock, `${t} missing from the prefers-color-scheme mirror`).toContain(t);
    }
  });
});

describe("THE SKELETON IS A MATERIAL, NOT A GREY SLAB", () => {
  const plate = stripComments(/\.skeleton \{[\s\S]*?\n\}/.exec(css)![0]);
  const sheen = stripComments(/\.skeleton::after \{[\s\S]*?\n\}/.exec(css)![0]);

  it("it has a lit top edge and a top-down grade", () => {
    // The two cheap details that make a placeholder read as a surface catching
    // light rather than as a rectangle.
    expect(plate).toMatch(/box-shadow: inset 0 1px 0 var\(--wd-skel-edge\)/);
    expect(plate).toMatch(/linear-gradient\(180deg, var\(--wd-skel-grade\)/);
  });

  it("the sheen is TILTED, so it rakes rather than slides", () => {
    // 90deg reads as a progress bar in disguise; a tilt reads as light.
    expect(sheen).toMatch(/linear-gradient\(\s*\n?\s*100deg/);
  });

  it("the sweep is NEVER staggered across grouped skeletons", () => {
    // The instinct is a cascade; every shipped design system says the opposite
    // (eBay's playbook and the Helix system both: keep grouped skeletons in
    // sync, never offset their delays). Offset sweeps read as chaos, not
    // luxury. One duration, one direction, zero delay, everywhere.
    expect(sheen, "no per-element delay may appear on the sweep").not.toMatch(/animation-delay/);
    expect(skeleton, "and none may be injected from the component").not.toMatch(/animationDelay/);
    expect(skeleton).not.toMatch(/nth-child/);
    expect(css).not.toMatch(/\.skeleton:nth-child/);
  });

  it("the breath is a whisper now that the sheen carries the signal", () => {
    // Both animations at full strength read as a cheap double-blink. The
    // breath exists only so the frame BETWEEN sweeps still says "working".
    const kf = css.slice(css.indexOf("@keyframes skeleton-breathe"));
    const body = kf.slice(0, kf.indexOf("\n}") + 2);
    const dip = Number(/opacity: ([\d.]+);\s*\n?\s*\}/.exec(body.slice(body.indexOf("50%")))?.[1]);
    expect(dip).toBeGreaterThanOrEqual(0.85);
    expect(dip).toBeLessThan(1);
  });

  it("the sweep keyframe is declared in the stylesheet, not only in the tailwind config", () => {
    // It lived ONLY in tailwind.config.ts, where Tailwind tree-shook it away (no
    // `animate-shimmer` utility was ever emitted), so `.skeleton::after`'s
    // `animation: shimmer` pointed at a keyframe that never shipped - every
    // skeleton was a flat opacity breath.
    expect(css).toMatch(/@keyframes shimmer \{\s*\n?\s*to \{ transform: translateX\(100%\); \}/);
    expect(css).toMatch(/\.skeleton::after \{[\s\S]*?animation: shimmer/);
  });

  it("a placeholder reserves the space its content will occupy", () => {
    // Skeletons exist to stop layout shift; one that does not size itself is
    // just a flash. Every Skeleton call site carries an explicit height.
    const calls = skeleton.match(/<Skeleton className="[^"]*"/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, `${c} has no height`).toMatch(/\bh-\d/);
  });
});

describe("the loader mark holds still - no scale-pulse, no draw-on", () => {
  it("the heartbeat and the draw-on are GONE from the stylesheet", () => {
    // A scaling logo is the single most dated loading element and precisely
    // what prefers-reduced-motion exists to remove; the owner named it, and the
    // outline sketch it rode on, as "the worst thing that I ever seen".
    const clean = stripComments(css);
    expect(clean).not.toMatch(/@keyframes wd-heartbeat/);
    expect(clean).not.toMatch(/\.wd-heartbeat/);
    expect(clean).not.toMatch(/@keyframes wd-draw-on/);
    expect(clean).not.toMatch(/\.wd-draw/);
  });

  it("the mark the loader renders does not animate its own transform", () => {
    expect(pulse).toMatch(/import \{ BrandMark \}/);
    expect(pulse).toMatch(/<BrandMark size=\{size\}/);
    expect(pulse).not.toMatch(/wd-heartbeat/);
    expect(pulse).not.toMatch(/variant="outline"/);
    expect(pulse).not.toMatch(/\baurora\b/);
    const mark = stripComments(readRaw("src/components/BrandMark.tsx"));
    expect(mark).not.toMatch(/variant/);
    expect(mark).not.toMatch(/wd-draw/);
    expect(mark).not.toMatch(/stroke="currentColor"/);
  });

  it("the loader's WHOLE motion is the neutral horizon line", () => {
    expect(pulse).toMatch(/wd-horizon/);
    expect(css).toMatch(/@keyframes wd-horizon-travel/);
    const horizon = css.slice(css.indexOf(".wd-horizon {"), css.indexOf(".wd-loader-veil"));
    expect(horizon).toMatch(/color-mix\(in oklch/);
    expect(horizon).toMatch(/animation: wd-horizon-travel/);
    expect(horizon, "the glint translates - nothing rotates").not.toMatch(/rotate/);
  });

  it("~1.6s ease-in-out - a calm glide, not an anxious sweep", () => {
    const dur = /animation: wd-horizon-travel ([\d.]+)s ease-in-out/.exec(css)?.[1];
    expect(Number(dur)).toBeGreaterThanOrEqual(1.2);
    expect(Number(dur)).toBeLessThanOrEqual(2);
  });

  it("the loader still rides the (lightened) veil", () => {
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
    for (const banned of [
      "framer-motion",
      "motion",
      "gsap",
      "react-spring",
      "@react-spring/web",
      "lottie-react",
    ]) {
      expect(all[banned], `${banned} must not be a dependency`).toBeUndefined();
    }
    expect(pulse).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
  });
});

describe("COVERAGE: one loading vocabulary, everywhere", () => {
  it("the search screen shows the still loader - it used to show nothing", () => {
    const page = stripComments(readRaw("src/app/page.tsx"));
    expect(page).toMatch(/<BrandPulse size=\{62\}/);
    expect(page).toMatch(/phase === "profiling"/);
  });

  it("the nav veil shows the SAME loader, so a route change reads like a search", () => {
    expect(veil).toMatch(/<BrandPulseVeil/);
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

  it("the search screen's skeleton cards carry the cheap shimmer only", () => {
    const page = readRaw("src/app/page.tsx");
    const start = page.indexOf('phase === "profiling"');
    const body = page.slice(start, page.indexOf("<AdBanner", start));
    expect((body.match(/<BrandPulse/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/className="[^"]*\baurora\b/);
  });

  it("OrbitDots stays effect-free - a primitive that needs decoration is not one", () => {
    expect(readRaw("src/components/OrbitDots.tsx")).not.toMatch(/aurora/i);
  });
});

describe("reduced motion keeps the substance and drops every movement", () => {
  it("the skeleton holds a visible still plate instead of sweeping", () => {
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".skeleton {"))
    );
    const body = reduced.slice(0, reduced.indexOf("\n}") + 2);
    expect(body).toMatch(/\.skeleton \{ animation: none; \}/);
    expect(body, "a frozen transparent sheen is an invisible placeholder").toMatch(/opacity: 0\.5/);
  });

  it("the horizon settles to a full still bar, not a glint parked mid-track", () => {
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".wd-horizon {"))
    );
    const body = reduced.slice(0, reduced.indexOf("\n}") + 2);
    expect(body).toMatch(/\.wd-horizon::after \{/);
    expect(body).toMatch(/animation: none/);
    expect(body).toMatch(/width: 100%/);
    expect(body, "and it keeps its neutral, never a hue").toMatch(/--wd-load-sheen/);
  });
});
