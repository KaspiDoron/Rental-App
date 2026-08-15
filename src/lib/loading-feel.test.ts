import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { shouldShowLoading, LOADING_GRACE_MS, LOADING_MIN_MS } from "./client/min-duration";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE LOADING STATE LOOKED CHEAP (items 1 and 12), in three separate ways.
//
// 1. The dots used Tailwind's `animate-bounce` - a hard translate on an
//    asymmetric cubic-bezier. That is a ball dropping, which is the shape of a
//    physics toy rather than of something thinking.
// 2. There was no ambient layer at the PAGE level at all. `.aurora::before` is
//    box-scoped (inset:-14%), so a full-screen wait was a small spinner on flat
//    background.
// 3. There was NO minimum-duration logic anywhere in the repo, so every fast
//    response drew a spinner for ~80ms and tore it down. The eye catches the
//    change without resolving it, and fast reads as broken.

describe("the timing contract - no flash, no forced wait", () => {
  const t0 = 1_000_000;

  it("work that finishes inside the grace period never shows anything", () => {
    // The whole point of the DELAY half. Without it, a minimum-duration rule
    // makes things worse: a 60ms fetch would be held on screen for 400ms and
    // turn instant into visibly slow.
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: t0 + 60, nowMs: t0 + 61 })
    ).toBe(false);
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: t0 + 60, nowMs: t0 + 5000 })
    ).toBe(false);
  });

  it("...and nothing is drawn during the grace period either", () => {
    expect(shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + 10 })).toBe(false);
  });

  it("slow work shows the indicator once the grace passes", () => {
    expect(
      shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + LOADING_GRACE_MS })
    ).toBe(true);
    expect(shouldShowLoading({ startedAt: t0, endedAt: null, nowMs: t0 + 3000 })).toBe(true);
  });

  it("once shown, it is held long enough to READ", () => {
    // Finished just after appearing: still held.
    const endedAt = t0 + LOADING_GRACE_MS + 20;
    expect(shouldShowLoading({ startedAt: t0, endedAt, nowMs: endedAt + 1 })).toBe(true);
  });

  it("...measured from when it APPEARED, not from when the work started", () => {
    // Holding from `startedAt` would cut the visible time short by the whole
    // grace period - the indicator would flash for less than the minimum it is
    // supposed to guarantee.
    const shownAt = t0 + LOADING_GRACE_MS;
    const endedAt = shownAt + 10;
    expect(
      shouldShowLoading({ startedAt: t0, endedAt, nowMs: shownAt + LOADING_MIN_MS - 1 })
    ).toBe(true);
    expect(
      shouldShowLoading({ startedAt: t0, endedAt, nowMs: shownAt + LOADING_MIN_MS + 1 })
    ).toBe(false);
  });

  it("idle is idle", () => {
    expect(shouldShowLoading({ startedAt: null, endedAt: null, nowMs: t0 })).toBe(false);
  });

  it("the grace is shorter than the hold, or the rule contradicts itself", () => {
    expect(LOADING_GRACE_MS).toBeLessThan(LOADING_MIN_MS);
  });
});

describe("the dots breathe rather than bounce", () => {
  const dots = readCode("src/components/LoadingDots.tsx");
  const css = read("src/app/globals.css");

  it("Tailwind's ball-drop is gone", () => {
    expect(dots).not.toMatch(/animate-bounce/);
    expect(dots).toMatch(/wd-dot-breathe/);
  });

  it("the keyframe is scale + opacity on a SYMMETRIC ease", () => {
    // An asymmetric bezier is what makes `animate-bounce` read as gravity.
    const kf = /@keyframes wd-breathe \{[\s\S]*?\n\}/.exec(css);
    expect(kf, "wd-breathe moved").toBeTruthy();
    expect(kf![0]).toMatch(/transform: scale/);
    expect(kf![0]).toMatch(/opacity/);
    expect(css).toMatch(/\.wd-dot-breathe[\s\S]{0,200}cubic-bezier\(0\.4, 0, 0\.6, 1\)/);
  });

  it("the stagger is NEGATIVE, so they do not light up in a row", () => {
    expect(dots).toMatch(/-0\.45 \+ i \* 0\.18/);
  });

  it("reduced motion gets a still dot, not a frozen half-scaled one", () => {
    const rm = css.slice(css.indexOf(".wd-dot-breathe"));
    expect(rm).toMatch(/prefers-reduced-motion[\s\S]{0,220}animation: none/);
    expect(rm).toMatch(/prefers-reduced-motion[\s\S]{0,260}transform: none/);
  });
});

describe("there is an ambient layer at the page level", () => {
  const css = read("src/app/globals.css");

  it("it is viewport-fixed and cannot eat taps", () => {
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css);
    expect(amb, ".wd-ambient moved").toBeTruthy();
    expect(amb![0]).toMatch(/position: fixed/);
    expect(amb![0]).toMatch(/pointer-events: none/);
  });

  it("it uses ALL SEVEN hue tokens, not invented colours", () => {
    // Owner report 4 item 9 asked for "more colors" and put the yellow and red
    // hues on low side lobes. Report 5 asked again - "add colors and make them
    // more visible" - and added the two BRIDGE hues (aqua between green and
    // blue, coral between yellow and pink) that close the visible gaps. Every
    // lobe must still come from a token: an invented colour here is how a wash
    // stops being recognisably ours.
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0];
    for (let i = 1; i <= 7; i++) {
      expect(amb, `--wd-hue-${i}`).toContain(`--wd-hue-${i}`);
    }
  });

  it("NO BRAND HUE LEAKS BACK INTO THE LOADING CHROME", () => {
    // THE SEPARATION IS THE WHOLE DESIGN (owner report 5): colour belongs to
    // the ambient wash, and the loading components are the greys of the
    // background. This is the pin that keeps a future "just tint the spinner
    // slightly" from undoing it. The hue tokens may be DEFINED anywhere, but
    // the only rule allowed to reference one is .wd-ambient.
    const chrome = [
      /\.skeleton \{[\s\S]*?\n\}/,
      /\.skeleton::after \{[\s\S]*?\n\}/,
      /\.wd-horizon \{[\s\S]*?\n\}/,
      /\.wd-horizon::after \{[\s\S]*?\n\}/,
    ];
    for (const re of chrome) {
      const block = re.exec(css);
      expect(block, `${re} moved`).toBeTruthy();
      expect(block![0], `${re} must not reference a brand hue`).not.toMatch(/--wd-hue-/);
    }
    // The dots are TSX, not CSS, and were the last holdout - three brand-hue
    // lightness steps until v4 made them neutral.
    expect(readCode("src/components/LoadingDots.tsx")).not.toMatch(/--wd-hue-/);
  });

  it("...and it sits BEHIND the content, not over it", () => {
    expect(/\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0]).toMatch(/z-index: 0/);
  });

  // OWNER REPORT 3, ITEM 5. The layer above shipped once before as DEAD CSS -
  // the stylesheet was pinned, the class was mounted by nothing, and the
  // premium loading wash never painted a frame. These pins hold the WIRING.

  it("THE MOUNT EXISTS: the root layout renders AmbientGlow", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/import \{ AmbientGlow \} from "@\/components\/AmbientGlow"/);
    expect(layout).toMatch(/<AmbientGlow \/>/);
    const glow = readCode("src/components/AmbientGlow.tsx");
    expect(glow).toMatch(/wd-ambient/);
    // Always mounted; visibility is the class toggle so the ease-out has an
    // element to run on.
    expect(glow).toMatch(/wd-ambient-on/);
  });

  it("top-heavy and fading down, like the owner asked - INTENSIFIED again in v4", () => {
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0];
    // The main lobes still hang ABOVE the viewport...
    expect(amb).toMatch(/at 22% -6%/);
    expect(amb).toMatch(/at 78% 4%/);
    // ...the side lobes still sit LOW so the wash wraps the whole screen...
    expect(amb).toMatch(/at 12% 64%/);
    expect(amb).toMatch(/at 90% 78%/);
    // ...the two v4 bridge lobes fill the mid-height gaps on both flanks...
    expect(amb).toMatch(/at 4% 40%/);
    expect(amb).toMatch(/at 98% 46%/);
    // ...every lobe reaches to 92% before fading, which is what makes
    // neighbours OVERLAP and mix rather than each dying out against the page.
    // That overlap is where most of v4's extra intensity comes from, so the
    // count is pinned: seven lobes, no early fade anywhere.
    expect(amb, "the lobes must reach further before fading").not.toMatch(/transparent 7[02]%/);
    expect((amb.match(/transparent 92%/g) ?? []).length).toBe(7);
    // ...and the mask now holds 0.62 all the way to 88% down (v3 held 0.45,
    // v2 held 0.28 at 78%), so the lower third is genuinely coloured - but it
    // still ENDS transparent at 100%, so the bottom edge never shouts and the
    // TabBar never sits in a haze.
    expect(amb).toMatch(/mask-image: linear-gradient\(to bottom,.*rgba\(0, 0, 0, 0\.62\) 88%, transparent 100%\)/);
  });

  it("brightness is theme work, INTENSIFIED: one raise level per canvas", () => {
    // Owner v4: brighter still. 0.6 -> 0.74 over near-white; the same over
    // #17191d would glare, so dark rides 0.5 -> 0.62 (lifted in step, never
    // matched). The dark values are RULES, not tokens, so the theme-mirror
    // test stays out of it - but both dark selectors must agree with each
    // other, and dark must stay strictly below light.
    expect(/\.wd-ambient-on \{[\s\S]*?\n\}/.exec(css)![0]).toMatch(/opacity: 0\.74/);
    expect(css).toMatch(/\[data-theme="dark"\] \.wd-ambient-on \{\s*\n\s*opacity: 0\.62;/);
    expect(css).toMatch(/:root:not\(\[data-theme\]\) \.wd-ambient-on \{\s*\n\s*opacity: 0\.62;/);
  });

  it("no blur pass - the low-end-Android budget rule", () => {
    const amb = /\.wd-ambient \{[\s\S]*?\n\}/.exec(css)![0];
    expect(amb).not.toMatch(/filter:/);
    // The breath animates transform only; visibility is the opacity
    // transition (instant in, eased out).
    const kf = css.slice(css.indexOf("@keyframes wd-ambient-breathe"));
    const body = kf.slice(0, kf.indexOf("\n}") + 2);
    expect(body).toMatch(/scale/);
    expect(body).not.toMatch(/opacity/);
    expect(/\.wd-ambient-on \{[\s\S]*?\n\}/.exec(css)![0]).toMatch(/transition: none/);
  });

  it("the real waits raise it, and every raise has a matching lower", () => {
    const page = readCode("src/app/page.tsx");
    // Search dispatch + mass bargain.
    expect((page.match(/raiseAmbient\(\)/g) ?? []).length).toBe(2);
    expect((page.match(/lowerAmbient\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Route transitions ride the NavVeil pair.
    const nav = readCode("src/components/NavVeil.tsx");
    expect(nav).toMatch(/raiseAmbient\(\);/);
    expect(nav).toMatch(/lowerAmbient\(\);/);
  });

  it("EVERY big loading state raises it - route fallbacks and the WA gate too", () => {
    // Owner report 4, item 9: the loading.tsx files are server components,
    // so hard navigations showed the heartbeat with no wash. AmbientRaiser
    // is the client leaf that closes that - a raise on mount, a lower on
    // unmount, with AmbientGlow's escape hatches covering any leak.
    const raiser = readCode("src/components/AmbientRaiser.tsx");
    expect(raiser).toMatch(/raiseAmbient\(\);/);
    expect(raiser).toMatch(/return \(\) => lowerAmbient\(\);/);
    for (const p of [
      "src/app/loading.tsx",
      "src/app/deals/loading.tsx",
      "src/app/profile/loading.tsx",
      "src/components/WaLockVeil.tsx",
    ]) {
      expect(readCode(p), `${p} must mount AmbientRaiser`).toMatch(/<AmbientRaiser \/>/);
    }
  });
});

describe("one loading vocabulary", () => {
  it("NavVeil renders the same BrandPulseVeil the route loaders use", () => {
    const nav = readCode("src/components/NavVeil.tsx");
    expect(nav).toMatch(/<BrandPulseVeil size=\{58\} layer="layer-veil" \/>/);
    expect(nav).not.toMatch(/<BrandPulse\s/);
  });

  it("the mass-bargain confirm shows its sending state", () => {
    const preview = readCode("src/components/MassBargainPreview.tsx");
    expect(preview).toMatch(/sending \? \(/);
    expect(preview).toMatch(/<LoadingDots light label=\{t\("Sending"\)\}/);
  });

  it("the shop photo placeholder is the shared skeleton shimmer", () => {
    const photo = readCode("src/components/ShopPhoto.tsx");
    expect(photo).toMatch(/className="skeleton absolute inset-0"/);
    expect(photo).not.toMatch(/animate-pulse bg-card2/);
  });

  it("the WhatsApp gate's checking state is de-flickered and on-brand", () => {
    const veil = readCode("src/components/WaLockVeil.tsx");
    expect(veil).toMatch(/useSteadyLoading\(checking\)/);
    expect(veil).toMatch(/<BrandPulse size=\{40\}/);
    expect(veil).not.toMatch(/OrbitDots/);
  });
});

describe("the shop photo holds its space while it loads", () => {
  const photo = readCode("src/components/ShopPhoto.tsx");

  it("a placeholder is drawn until the image decodes", () => {
    expect(photo).toMatch(/shop-photo-placeholder/);
    expect(photo).toMatch(/onLoad=\{\(\) => setLoaded\(true\)\}/);
  });

  it("the image fades in rather than popping", () => {
    expect(photo).toMatch(/transition-opacity/);
  });

  it("a broken photo still falls back honestly, as before", () => {
    // The failure path predates this and must survive it: a dead Places SKU
    // shows a calm panel, never the browser's broken-image glyph.
    expect(photo).toMatch(/if \(!src \|\| broken\)/);
  });
});

describe("the proxy lets anything cache the photo", () => {
  const route = readCode("src/app/api/photo/route.ts");

  it("the CDN gets an s-maxage, not just the browser", () => {
    // `max-age` alone tells a CDN nothing, so every viewer of every shop
    // re-fetched an 800px original through this Node route.
    expect(route).toMatch(/s-maxage=/);
    expect(route).toMatch(/immutable/);
  });

  it("...and the upstream fetch stopped forcing a miss", () => {
    expect(route).not.toMatch(/cache: "no-store",\s*\n\s*signal/);
    expect(route).toMatch(/cache: "force-cache"/);
  });

  it("a FAILED photo is still never cached", () => {
    // Caching a 502 would pin a transient Places outage onto every viewer.
    expect(route).toMatch(/FAIL_HEADERS = \{ "Cache-Control": "private, no-store" \}/);
  });
});
