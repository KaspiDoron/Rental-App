import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { railVendors, RAIL_MAX, RAIL_MIN } from "./quotes-rail";
import { I18N_CATALOG } from "./i18n-catalog";
import type { Vendor } from "./types";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// M10: THE SECOND AXIS.
//
// The vertical feed holds every shop in the traveller's sort order, so finding
// the second-cheapest quote means scrolling past every shop still being
// contacted and every one that went quiet. The rail carries only the shops
// that answered with a price.

let n = 0;
function shop(opts: { price?: number; list?: number; name?: string } = {}): Vendor {
  n += 1;
  const v = {
    id: `v${n}`,
    name: opts.name ?? `Shop ${n}`,
    rating: 4,
    reviews: 10,
  } as unknown as Vendor;
  if (opts.price !== undefined) {
    (v as Vendor).offer = {
      pricePerDay: opts.price,
      listPricePerDay: opts.list ?? opts.price,
      currency: "THB",
    } as Vendor["offer"];
  }
  return v;
}

describe("the rail carries quotes, cheapest first", () => {
  it("only shops with a live price", () => {
    const rail = railVendors([shop(), shop({ price: 300 }), shop()]);
    expect(rail).toHaveLength(1);
    expect(rail[0].offer?.pricePerDay).toBe(300);
  });

  it("cheapest leads, whatever the feed is sorted by", () => {
    // The feed may be on "Closest" or "Best rating"; the rail's job is price.
    const rail = railVendors([shop({ price: 500 }), shop({ price: 200 }), shop({ price: 350 })]);
    expect(rail.map((v) => v.offer!.pricePerDay)).toEqual([200, 350, 500]);
  });

  it("a zero price is not a quote", () => {
    // A price of 0 is a parse failure, not a free scooter - and this app has
    // shipped a "Bargained to 0" card before.
    expect(railVendors([shop({ price: 0 })])).toHaveLength(0);
  });

  it("it is bounded, so the strip never needs windowing", () => {
    const many = Array.from({ length: 40 }, (_, i) => shop({ price: 100 + i }));
    expect(railVendors(many)).toHaveLength(RAIL_MAX);
    // And it keeps the CHEAPEST ones, not the first ones it happened to see.
    expect(railVendors(many)[0].offer!.pricePerDay).toBe(100);
  });

  it("it does not mutate the array the feed is rendering", () => {
    // `.sort()` in place on the caller's list would silently reorder the
    // vertical feed as a side effect of drawing the rail.
    const list = [shop({ price: 500 }), shop({ price: 200 })];
    const before = list.map((v) => v.id);
    railVendors(list);
    expect(list.map((v) => v.id)).toEqual(before);
  });

  it("a single quote is below the floor", () => {
    // One tile says nothing the card beneath it does not, and costs a row of
    // vertical space on a 320px screen to say it.
    expect(RAIL_MIN).toBeGreaterThan(1);
  });
});

describe("the rail cannot break the windowed list", () => {
  const rail = stripComments(readRaw("src/components/QuotesRail.tsx"));
  const lib = stripComments(readRaw("src/lib/quotes-rail.ts"));
  const list = stripComments(readRaw("src/components/VirtualVendorList.tsx"));

  it("it does not import or wrap the virtualizer", () => {
    expect(rail).not.toMatch(/VirtualVendorList|useWindowVirtualizer/);
    expect(lib).not.toMatch(/VirtualVendorList|useWindowVirtualizer/);
  });

  it("the windowed list still scrolls the PAGE, not a container", () => {
    // Wrapping it would break scroll restoration, the sticky panel and iOS
    // momentum at once - the rail is a sibling strip precisely to avoid that.
    expect(list).toMatch(/useWindowVirtualizer/);
    expect(list).not.toMatch(/overflow-y-auto|overflow-auto/);
  });

  it("the strip owns its own horizontal overflow, so the page never scrolls sideways", () => {
    expect(rail).toMatch(/overflow-x-auto/);
  });

  it("it relies on normal flow, so RTL mirrors it without hand-flipping", () => {
    // The windowed rows are absolutely positioned and must flip `left` by
    // hand; these are flex children and must NOT acquire that machinery.
    expect(rail).not.toMatch(/position: "absolute"|wd-lane-offset/);
    expect(rail).toMatch(/flex/);
  });
});

describe("the rail derives nothing of its own", () => {
  const page = stripComments(readRaw("src/app/page.tsx"));

  it("it is handed the same array the feed renders", () => {
    expect(page).toMatch(/<QuotesRail[\s\S]{0,160}vendors=\{filtered\}/);
    expect(page).toMatch(/<VirtualVendorList[\s\S]{0,120}vendors=\{filtered\}/);
  });

  it("a tap drives the feed through the jump that already existed", () => {
    // scrollToVendor is what the status panel and the push deep-links use, and
    // it is the only thing that can reach an unmounted windowed row.
    expect(page).toMatch(/<QuotesRail[\s\S]{0,200}onPick=\{scrollToVendor\}/);
  });

  it("selection is shared, not a second highlighted shop", () => {
    expect(page).toMatch(/<QuotesRail[\s\S]{0,200}selectedId=\{selectedId\}/);
  });
});

describe("prices on the rail read like prices everywhere else", () => {
  const rail = stripComments(readRaw("src/components/QuotesRail.tsx"));
  const lib = stripComments(readRaw("src/lib/quotes-rail.ts"));

  it("it renders the shop's own money, never a converted figure", () => {
    // Offers arrive in the vendor's currency; moneyLocal formats without
    // converting, which is the rule the card follows too.
    expect(rail).toMatch(/moneyLocal\(offer\.pricePerDay, offer\.currency\)/);
    expect(rail).not.toMatch(/convertApprox/);
  });

  it("a drop compares the shop against ITSELF", () => {
    // list price vs live price - not against another shop's number.
    expect(rail).toMatch(/offer\.pricePerDay < offer\.listPricePerDay/);
  });

  it("its copy is translated", () => {
    for (const s of ["Quotes so far", "down from", "day", "shops"]) {
      expect(I18N_CATALOG, `missing from the catalogue: "${s}"`).toContain(s);
    }
  });
});
