import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// FORTY SHOPS IS FORTY HEAVY CARDS.
//
// A photo, an avatar, a tracker pipeline, an option list, a composer, and a
// thread peek with its own poll - per card, all mounted, all re-rendering on
// every activity tick, on a phone. "Show 20 more" was the old defence and it
// was a bad one twice over: it made the traveller work to see shops the app
// already had, and it did nothing at all once tapped, which is exactly the
// moment the list is heaviest.

const page = readCode("src/app/page.tsx");
const list = readCode("src/components/VirtualVendorList.tsx");

describe("the vendor list is windowed", () => {
  it("the dependency is real and pinned", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@tanstack/react-virtual"]).toBeTruthy();
    expect(list).toMatch(/from "@tanstack\/react-virtual"/);
  });

  it("REPRODUCTION: the 'Show 20 more' pagination is gone", () => {
    expect(page).not.toMatch(/visibleCount/);
    expect(page).not.toMatch(/setVisibleCount|Show\{?" \}?\{Math\.min\(20/);
    expect(page).toMatch(/<VirtualVendorList/);
  });

  it("only the rows near the viewport are mounted", () => {
    // The bounded-DOM guarantee: `count` is every vendor, but the render maps
    // over getVirtualItems(), which is overscan-bounded rather than list-bound.
    expect(list).toMatch(/count: vendors\.length/);
    expect(list).toMatch(/const items = virtualizer\.getVirtualItems\(\);/);
    expect(list).toMatch(/\{items\.map\(\(item\) => \{/);
    expect(list).toMatch(/overscan: OVERSCAN/);
    expect(list).toMatch(/const OVERSCAN = \d+;/);
  });

  it("cards are MEASURED, not assumed - their heights genuinely differ", () => {
    // An offer, a queued chip and an options menu are all different heights,
    // and they change as replies land.
    expect(list).toMatch(/ref=\{virtualizer\.measureElement\}/);
    expect(list).toMatch(/measureElement: \(el\) => el\.getBoundingClientRect\(\)\.height/);
  });
});

describe("it scrolls the PAGE, not a box inside it", () => {
  it("the window virtualizer is used, with the list's own offset", () => {
    // A private overflow container would break scroll restoration, the sticky
    // status panel and iOS momentum in one move.
    expect(list).toMatch(/useWindowVirtualizer/);
    expect(list).toMatch(/scrollMargin: offset/);
    expect(list).toMatch(/item\.start - virtualizer\.options\.scrollMargin/);
  });

  it("the two-column layout survives as lanes", () => {
    expect(list).toMatch(/lanes,/);
    expect(list).toMatch(/window\.innerWidth >= TWO_COLUMN_MIN_PX \? 2 : 1/);
    expect(list).toMatch(/item\.lane \* 50/);
  });
});

describe("REPRODUCTION: jumping to a shop that is not mounted", () => {
  it("the caller asks the virtualizer to bring the row in first", () => {
    // The status panel and the push deep-links jump straight to a shop, and a
    // windowed row far down has no DOM node for scrollIntoView to find. The
    // old fix grew the pagination window past the index; that lever is gone.
    expect(list).toMatch(/virtualizer\.scrollToIndex\(scrollToIndex, \{ align: "center" \}\)/);
    expect(page).toMatch(/if \(idx >= 0\) setScrollToIndex\(idx\);/);
    expect(page).toMatch(/scrollToIndex=\{scrollToIndex\}/);
  });

  it("...and scrollIntoView still does the fine positioning afterwards", () => {
    expect(page).toMatch(/document\.getElementById\(`vendor-\$\{id\}`\)\?\.scrollIntoView/);
  });

  it("a new hunt clears a stale target from the previous one", () => {
    expect(page).toMatch(/setScrollToIndex\(null\)/);
  });
});
