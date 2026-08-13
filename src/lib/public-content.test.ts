import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { GUIDES, guideBySlug, guideText, GUIDE_CATEGORY_LABELS } from "./guides";

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
  it("there is a real library now - twenty guides, five clusters (wave 4.4)", () => {
    expect(GUIDES.length).toBeGreaterThanOrEqual(20);
    const cats = new Set(GUIDES.map((g) => g.category));
    expect(cats.size).toBeGreaterThanOrEqual(5);
  });

  it("each one is substantive rather than a placeholder", () => {
    for (const g of GUIDES) {
      expect(g.sections.length, `${g.slug} has too few sections`).toBeGreaterThanOrEqual(3);
      const words = guideText(g).split(/\s+/).length;
      // Thin content is the exact rejection reason. The floor moved from 300
      // to 600 with the 4.4 library - a guide under that is a stub.
      expect(words, `${g.slug} is only ${words} words`).toBeGreaterThan(600);
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

  it("every related slug resolves and no guide relates to itself", () => {
    for (const g of GUIDES) {
      expect(g.related.length, `${g.slug} has no related rail`).toBeGreaterThan(0);
      for (const r of g.related) {
        expect(guideBySlug(r), `${g.slug} relates to missing ${r}`).toBeDefined();
        expect(r, `${g.slug} relates to itself`).not.toBe(g.slug);
      }
    }
  });

  it("categories are real and dates are ISO", () => {
    for (const g of GUIDES) {
      expect(GUIDE_CATEGORY_LABELS[g.category], `${g.slug} category`).toBeTruthy();
      expect(g.updated, `${g.slug} updated`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("cross-guide originality: no paragraph is copy-pasted between guides", () => {
    // Duplicated content across pages is its own AdSense rejection reason
    // ("scraped or duplicated"). Paragraph-level identity is the honest bar -
    // shared short phrases are fine, shared paragraphs are not.
    const seen = new Map<string, string>();
    for (const g of GUIDES) {
      for (const s of g.sections) {
        for (const b of s.blocks) {
          if (b.kind !== "p") continue;
          const key = b.text.trim();
          if (key.length < 80) continue;
          const owner = seen.get(key);
          expect(owner, `paragraph shared by ${owner} and ${g.slug}: "${key.slice(0, 60)}..."`).toBeUndefined();
          seen.set(key, g.slug);
        }
      }
    }
  });

  it("only short hyphens in guide prose (the CLAUDE.md rule)", () => {
    for (const g of GUIDES) {
      expect(guideText(g), `${g.slug} contains an em/en dash`).not.toMatch(/[–—]/);
    }
  });
});

describe("structured data + discoverability (wave 4.4)", () => {
  const detail = readCode("src/app/guides/[slug]/page.tsx");

  it("Article + BreadcrumbList JSON-LD derive from the same guide object", () => {
    expect(detail).toMatch(/application\/ld\+json/);
    expect(detail).toMatch(/"Article"/);
    expect(detail).toMatch(/"BreadcrumbList"/);
  });

  it("FAQPage markup exists exactly when the guide carries a faq", () => {
    expect(detail).toMatch(/guide\.faq && guide\.faq\.length > 0/);
    expect(detail).toMatch(/"FAQPage"/);
    // ...and at least some guides actually carry one.
    expect(GUIDES.some((g) => (g.faq?.length ?? 0) > 0)).toBe(true);
  });

  it("the related rail renders from resolvable slugs", () => {
    expect(detail).toMatch(/guide\.related/);
  });

  it("guides are reachable from the public chrome, not only the sitemap", () => {
    expect(readCode("src/components/SiteFooter.tsx")).toMatch(/href="\/guides"/);
    expect(readCode("src/app/welcome/page.tsx")).toMatch(/href="\/guides"/);
    expect(readCode("src/app/pricing/page.tsx")).toMatch(/href="\/guides"/);
  });

  it("guide tables are their own scrollers - the page never scrolls sideways", () => {
    expect(detail).toMatch(/overflow-x-auto overscroll-x-contain/);
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
