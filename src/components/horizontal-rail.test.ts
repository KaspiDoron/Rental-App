import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE REAL HORIZONTAL MODE (owner report 3, item 12).
//
// "There is still not a horizontal scroll of the vendor cards!" - because
// what shipped was QuotesRail, a compact strip of price quotes, not the
// cards. This is the actual thing: the SAME VendorCard the vertical feed
// renders, one per snap stop, with a persisted toggle between the two axes.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the rail is a real horizontal scroller", () => {
  const rail = readCode("src/components/HorizontalVendorRail.tsx");

  it("the STRIP scrolls, never the page (the 320px rule)", () => {
    expect(rail).toMatch(/overflow-x-auto/);
    expect(rail).toMatch(/overscroll-x-contain/);
    expect(rail).toMatch(/no-scrollbar/);
  });

  it("cards snap, one per stop, phone-width capped", () => {
    expect(rail).toMatch(/snap-x snap-mandatory/);
    expect(rail).toMatch(/w-\[85vw\] max-w-\[360px\] shrink-0 snap-center/);
  });

  it("it renders whatever card the page hands it - no second card implementation", () => {
    expect(rail).toMatch(/renderCard\(v, i\)/);
    expect(rail).not.toMatch(/VendorCard/);
  });
});

describe("both axes render the identical card", () => {
  const page = readCode("src/app/page.tsx");

  it("ONE renderVendorCard closure feeds both lists", () => {
    expect(page).toMatch(/const renderVendorCard = \(v: Vendor, i: number\) =>/);
    expect(page).toMatch(/<HorizontalVendorRail vendors=\{filtered\} renderCard=\{renderVendorCard\} \/>/);
    expect(page).toMatch(/renderCard=\{renderVendorCard\}\s*\n\s*\/>/);
    // The old inline duplicate is gone - VendorCard is mounted through the
    // shared closure only (map strip and dashboards render their own
    // surfaces, not VendorCard).
    expect((page.match(/<VendorCard/g) ?? []).length).toBe(1);
  });

  it("the choice is remembered like the language is", () => {
    expect(page).toMatch(/localStorage\.getItem\("wd_list_axis"\)/);
    expect(page).toMatch(/localStorage\.setItem\("wd_list_axis", a\)/);
    // Default stays the vertical feed - the axis only flips on an explicit
    // stored choice.
    expect(page).toMatch(/useState<"vertical" \| "horizontal">\("vertical"\)/);
  });

  it("a status-panel jump centres the card INSIDE the rail, not the page", () => {
    expect(page).toMatch(/inline: "center", block: "nearest"/);
    // The vertical branch keeps its virtualizer pre-scroll.
    expect(page).toMatch(/setScrollRequest\(\{ index: idx/);
  });

  it("the toggle lives on the sort row, list view only", () => {
    const filters = readCode("src/components/Filters.tsx");
    expect(filters).toMatch(/onAxis\("vertical"\)/);
    expect(filters).toMatch(/onAxis\("horizontal"\)/);
    expect(page).toMatch(/view === "list" \? \{ axis: listAxis, onAxis: setListAxis \}/);
  });

  it("the quotes strip yields in horizontal mode - two stacked rails is not a layout", () => {
    expect(page).toMatch(/\{listAxis === "vertical" && \(\s*\n\s*<QuotesRail/);
  });
});
