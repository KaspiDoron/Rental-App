import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildHistoryWindow, historyLine } from "./wa/history-window";
import { rankPresentable } from "./offer-presentation";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P2: the surfaces that still disagreed, and the silent caps.

describe("the compare sheet crowns the same winner as every other surface", () => {
  const offer = (pricePerDay: number, currency = "THB") => ({
    pricePerDay,
    currency,
    vehicleStatus: "confirmed" as const,
    matchesSpec: true,
  });

  it("THE REGRESSION: it can no longer call a foreign currency cheaper", () => {
    // 20 EUR is not cheaper than 500 THB, but a raw numeric reduce said it was.
    const vendors = [
      { id: "thb", offer: offer(500, "THB") },
      { id: "eur", offer: offer(20, "EUR") },
    ];
    const ranked = rankPresentable(vendors, "THB");
    expect(ranked.map((v) => v.id)).toEqual(["thb"]);
  });

  it("a shop with nothing to rent never wears the badge", () => {
    const vendors = [
      { id: "gone", offer: offer(100), stage: "out-of-stock" },
      { id: "here", offer: offer(180) },
    ];
    expect(rankPresentable(vendors, "THB")[0]?.id).toBe("here");
  });

  it("the sheet uses the shared ranker, not its own reduce", () => {
    const sheet = read("src/components/will/CompareSheet.tsx");
    expect(sheet).toMatch(/rankPresentable\(vendors, dominantCurrency\)/);
    expect(sheet).not.toMatch(/cols\.reduce<Vendor \| null>/);
    // ...and the columns it shows are that same ranking, so the green
    // "cheapest" is always one of the three on screen.
    expect(sheet).toMatch(/const cols = ranked\.slice\(0, 3\)/);
    expect(sheet).toMatch(/const cheapest = ranked\[0\] \?\? null/);
  });
});

describe("an empty shop message stops leaking into the composer's history", () => {
  it("THE OFF-BY-PREFIX: 'Shop: ' is 6 chars, so length > 4 let it through", () => {
    // The filter measured the rendered line, prefix included - so an empty
    // OUTBOUND ("Us: ") was dropped and an empty INBOUND ("Shop: ") survived,
    // feeding the composer a shop turn that said nothing.
    expect(historyLine({ direction: "inbound", body: "", raw: null })).toBe("");
    expect(historyLine({ direction: "inbound", body: "   ", raw: null })).toBe("");
    expect(historyLine({ direction: "outbound", body: "", raw: null })).toBe("");
  });

  it("...and the window drops them", () => {
    const out = buildHistoryWindow([
      { direction: "outbound", body: "Hi, what is your daily rate?", raw: null },
      { direction: "inbound", body: "", raw: null },
      { direction: "inbound", body: "250 baht", raw: null },
    ]);
    expect(out).not.toMatch(/Shop:\s*$/m);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toMatch(/Shop: 250 baht/);
  });

  it("a genuinely SHORT message still counts - this drops empty, not brief", () => {
    expect(historyLine({ direction: "inbound", body: "ok", raw: null })).toBe("Shop: ok");
    expect(buildHistoryWindow([{ direction: "outbound", body: "ok", raw: null }])).toBe("Us: ok");
  });
});

describe("two silent ceilings that made the app look emptier than it was", () => {
  it("the activity queue reads past 50 rows", () => {
    // An Ultra hunt parks two dozen openers plus replies; at 50 the queue
    // rendered as if it ended there.
    const route = read("src/app/api/activity/route.ts");
    expect(route).toMatch(/select=id,to_number,not_before,meta[^`]*limit=200/);
  });

  it("the host probe outlasts the thing it is measuring", () => {
    // 4500ms sat BELOW Render's own 5s health budget, so a merely-slow host
    // was reported as a dead one.
    const evo = read("src/lib/evolution.ts");
    expect(evo).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), 9_000\)/);
    expect(evo).not.toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), 4500\)/);
  });
});
