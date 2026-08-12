import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { GUIDES, guideBySlug } from "./guides";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "ADSENSE REJECTED US FOR LOOKING LIKE A SAAS APP UI" - it never saw the app.
//
// `robots.ts` already allows everything public AND explicitly welcomes
// Mediapartners-Google, and /welcome, /pricing, /terms and /privacy all sit
// OUTSIDE the middleware matcher. The crawler was never blocked. The crawlable
// site was simply FOUR URLS, two of which are short legal templates - which is
// textbook "Low value content". A four-post blog would be rejected identically.
//
// So the fix is content, and the thing that keeps content honest is that it has
// to be worth publishing even if there were no ad network: these are the
// questions this app's own users ask before they rent anything.

describe("the public surface is no longer four pages", () => {
  it("there are real guides, not a stub", () => {
    expect(GUIDES.length).toBeGreaterThanOrEqual(4);
  });

  it("each one is substantive rather than a placeholder", () => {
    for (const g of GUIDES) {
      expect(g.sections.length, `${g.slug} has too few sections`).toBeGreaterThanOrEqual(3);
      const words = g.sections
        .flatMap((s) => s.body)
        .join(" ")
        .split(/\s+/).length;
      // Thin content is the exact rejection reason. A guide under ~300 words is
      // a stub with a heading on it.
      expect(words, `${g.slug} is only ${words} words`).toBeGreaterThan(300);
    }
  });

  it("slugs are unique, url-safe and resolvable", () => {
    const slugs = GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) {
      expect(s).toMatch(/^[a-z0-9-]+$/);
      expect(guideBySlug(s)?.slug).toBe(s);
    }
  });

  it("an unknown slug resolves to nothing, so the route can 404 honestly", () => {
    expect(guideBySlug("does-not-exist")).toBeUndefined();
  });

  it("every guide carries a summary for the card AND the meta description", () => {
    for (const g of GUIDES) {
      expect(g.summary.length, g.slug).toBeGreaterThan(40);
      expect(g.title.length, g.slug).toBeGreaterThan(10);
    }
  });
});

describe("the sitemap cannot disagree with the pages", () => {
  const sitemap = readCode("src/app/sitemap.ts");

  it("guide URLs are DERIVED, never a second hand-kept list", () => {
    // A sitemap that advertises a 404 is worse than no sitemap - the crawler
    // discounts everything else in it.
    expect(sitemap).toMatch(/GUIDES\.map/);
    expect(sitemap).toMatch(/\/guides\/\$\{g\.slug\}/);
  });

  it("the hub itself is listed", () => {
    expect(sitemap).toMatch(/path: "\/guides"/);
  });

  it("the detail route is statically generated from the same array", () => {
    const page = readCode("src/app/guides/[slug]/page.tsx");
    expect(page).toMatch(/generateStaticParams/);
    expect(page).toMatch(/GUIDES\.map\(\(g\) => \(\{ slug: g\.slug \}\)\)/);
  });
});

describe("the crawler was never the blocker, and still is not", () => {
  const robots = readCode("src/app/robots.ts");
  const middleware = readCode("src/middleware.ts");

  it("the ad crawler is explicitly welcomed", () => {
    expect(robots).toMatch(/Mediapartners-Google/);
  });

  it("/guides is not behind the sign-in redirect", () => {
    // The matcher is the real gate. A guide that bounces to /login would
    // advertise a redirect as content, which is the same rejection reason in a
    // different costume.
    const matcher = /matcher: \[([^\]]*)\]/.exec(middleware);
    expect(matcher, "the middleware matcher moved").toBeTruthy();
    expect(matcher![1]).not.toContain("guides");
  });

  it("...and is not disallowed in robots either", () => {
    const dis = /disallow: \[([^\]]*)\]/.exec(robots);
    expect(dis, "the disallow list moved").toBeTruthy();
    expect(dis![1]).not.toContain("guides");
  });
});

describe("no empty ad frames", () => {
  const banner = readCode("src/components/AdBanner.tsx");

  it("nothing renders without a real client AND a real unit", () => {
    // A labelled, permanently unfilled 100px slot reads as either a broken
    // integration or a page built around ads - both are things the policy
    // review looks for.
    expect(banner).toMatch(/if \(!client \|\| !adSlot\) return null;/);
  });

  it("the 'Ad space' placeholder panel is gone", () => {
    expect(banner).not.toMatch(/Ad space/);
    expect(banner).not.toMatch(/waiting for Google to serve/);
  });

  it("paid plans still see nothing at all", () => {
    expect(banner).toMatch(/if \(!free\) return null;/);
  });
});
