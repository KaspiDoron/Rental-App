import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WAVE 1 (owner report 5) - THE SCREEN TELLS THE TRUTH IT ALREADY KNOWS.
//
// "No price yet - your agent is asking for one" was the else-branch of one
// boolean (vendor_replies.found) while the app KNEW the price in four other
// places: the thread's standing field, the photographed board (raw.reading -
// already used as rival leverage in OTHER shops' threads!), the derived option
// menu, and the reply text itself. These pins hold the whole path together:
// server rollup -> client admission -> card provenance. Each assertion fails on
// a revert of its edit.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("/api/replies - the effective price consults every source, in trust order", () => {
  const src = read("src/app/api/replies/route.ts");

  it("reads the photographed board's prices (raw->reading) for the card", () => {
    expect(src).toMatch(/reading:raw->reading/);
    expect(src).toMatch(/readingPricesByVendor/);
  });

  it("computes effectivePrice: thread field, then menu photo, then derived menu", () => {
    const block = src.slice(src.indexOf("const effectivePrice"));
    const thread = block.indexOf('"thread"');
    const photo = block.indexOf('"menu-photo"');
    const menu = block.indexOf('"menu"', photo + 12);
    expect(thread).toBeGreaterThan(-1);
    expect(photo).toBeGreaterThan(thread);
    expect(menu).toBeGreaterThan(photo);
    // Only when the row itself has nothing - a confirmed price wins outright.
    expect(block).toMatch(/if \(r\.found && r\.price_per_day\) return null/);
  });

  it("ships it to the client on every reply row", () => {
    expect(src).toMatch(/effectivePrice,\s*[\r\n]\s*createdAt/);
  });
});

describe("the client ADMITS a sourced price instead of dropping the row", () => {
  const page = read("src/app/page.tsx");

  it("a row with an effectivePrice is no longer skipped", () => {
    // The old drop: `if (!r.found || !r.pricePerDay) continue;` - which threw
    // away everything ON the row (options, thread price, board price).
    expect(page).not.toMatch(/if \(!r\.found \|\| !r\.pricePerDay\) continue;/);
    expect(page).toMatch(/if \(!confirmed && !r\.effectivePrice\?\.pricePerDay\) continue;/);
  });

  it("a confirmed row always outranks a sourced one, whatever the timestamps", () => {
    expect(page).toMatch(/\(confirmed && !curConfirmed\)/);
  });

  it("a sourced price never replaces a confirmed offer and never inflates the round", () => {
    expect(page).toMatch(/if \(!confirmedRow && v\.offer && !v\.offer\.priceSource\) return v;/);
    expect(page).toMatch(/confirmedRow \? v\.offer\.round \+ 1 : v\.offer\.round/);
  });
});

describe("provenance is DISCLOSED wherever the price shows", () => {
  it("the vendor card says where a sourced price came from", () => {
    const card = read("src/components/VendorCard.tsx");
    expect(card).toMatch(/offer\.priceSource/);
    expect(card).toMatch(/price-menu photo/);
  });

  it("the status panel carries the provenance chip", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/from menu photo/);
    expect(page).toMatch(/from price menu/);
  });
});

describe("the deposit chip shows EVERY alternative (owner report 5 #9)", () => {
  it("the status panel renders depositSummary, not the legacy single enum", () => {
    const page = read("src/app/page.tsx");
    // The exact literal that reported "passport or money4000" as passport-only.
    expect(page).not.toMatch(
      /depositType === "passport" \? t\("Passport deposit"\) : v\.offer\.deposit/
    );
    expect(page).toMatch(/depositSummary\(/);
  });

  it("the compare sheet uses the same shared summary", () => {
    const sheet = read("src/components/will/CompareSheet.tsx");
    expect(sheet).toMatch(/depositSummary\(/);
    expect(sheet).not.toMatch(/o\.depositType === "passport"\s*\?\s*t\("passport"\)/);
  });
});
