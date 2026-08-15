import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { validRivals, sessionFloor, leverageIsLive } from "./session-rivals";
import type { SessionShopRow } from "../graph/types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const row = (o: Partial<SessionShopRow> & { vendorId: string }): SessionShopRow => ({
  vendorName: `Shop ${o.vendorId}`,
  currency: "THB",
  ...o,
});

const THIS = "shopB";
const opts = { excludeVendorId: THIS, currency: "THB" };

describe("a rival is a quote the traveller could actually take", () => {
  it("REPRODUCTION: Shop A quoted 200, Shop B's turn sees 200", () => {
    // The whole mechanism, in one assertion. Before the routing fix this only
    // held on the inline reply path - every SCHEDULED follow-up negotiated with
    // no cross-chat leverage at all.
    const rivals = validRivals(
      [row({ vendorId: "shopA", pricePerDay: 200 }), row({ vendorId: THIS, pricePerDay: 250 })],
      opts
    );
    expect(rivals).toEqual([{ vendorId: "shopA", shop: "Shop shopA", pricePerDay: 200, currency: "THB" }]);
  });

  it("a shop that WITHDREW is not leverage - the traveller cannot go there", () => {
    const rows = [
      row({ vendorId: "dead", pricePerDay: 150, phase: "dead" }),
      row({ vendorId: "closed", pricePerDay: 160, phase: "closed" }),
      row({ vendorId: "closing", pricePerDay: 170, phase: "closing" }),
      row({ vendorId: "live", pricePerDay: 200, phase: "negotiating" }),
    ];
    expect(validRivals(rows, opts).map((r) => r.vendorId)).toEqual(["live"]);
  });

  it("a shop with no price is not a rival, it is just crowding the list", () => {
    const rows = [row({ vendorId: "silent" }), row({ vendorId: "priced", pricePerDay: 210 })];
    expect(validRivals(rows, opts).map((r) => r.vendorId)).toEqual(["priced"]);
  });

  it("a quote in ANOTHER currency is invented leverage, not leverage", () => {
    const rows = [
      row({ vendorId: "malaysia", pricePerDay: 60, currency: "MYR" }),
      row({ vendorId: "thai", pricePerDay: 220, currency: "THB" }),
    ];
    expect(validRivals(rows, opts).map((r) => r.vendorId)).toEqual(["thai"]);
  });

  it("this shop is never its own rival", () => {
    expect(validRivals([row({ vendorId: THIS, pricePerDay: 100 })], opts)).toEqual([]);
  });

  it("a shop the traveller removed stays out", () => {
    const rows = [row({ vendorId: "removed", pricePerDay: 100 }), row({ vendorId: "kept", pricePerDay: 300 })];
    expect(
      validRivals(rows, { ...opts, excludeVendorIds: ["removed"] }).map((r) => r.vendorId)
    ).toEqual(["kept"]);
  });

  it("cheapest first, and bounded - the rest are not arguments", () => {
    const rows = [500, 100, 400, 200, 300, 150].map((p, i) =>
      row({ vendorId: `v${i}`, pricePerDay: p })
    );
    expect(validRivals(rows, opts).map((r) => r.pricePerDay)).toEqual([100, 150, 200, 300]);
  });
});

describe("the session floor is a different question from leverage", () => {
  it("it INCLUDES this shop - it is the F5 comparison, not an argument", () => {
    const rows = [row({ vendorId: "shopA", pricePerDay: 200 }), row({ vendorId: THIS, pricePerDay: 180 })];
    expect(sessionFloor(rows, "THB")).toEqual({ vendorId: THIS, shop: "Shop shopB", pricePerDay: 180 });
  });

  it("...but a floor nobody can honour is not a floor", () => {
    const rows = [
      row({ vendorId: "gone", pricePerDay: 120, phase: "dead" }),
      row({ vendorId: "here", pricePerDay: 200 }),
    ];
    expect(sessionFloor(rows, "THB")?.pricePerDay).toBe(200);
  });

  it("no live quote anywhere yet: null, never a guess", () => {
    expect(sessionFloor([row({ vendorId: "a" })], "THB")).toBeNull();
  });
});

describe("when the card is worth playing", () => {
  it("this shop is ABOVE the cheapest rival: push it", () => {
    const rivals = validRivals([row({ vendorId: "shopA", pricePerDay: 200 })], opts);
    expect(leverageIsLive({ thisShopPricePerDay: 250, rivals })).toBe(true);
  });

  it("REPRODUCTION: this shop IS the floor - do not argue it against itself", () => {
    // The F5 failure: the agent pushing a shop to beat a price the shop is
    // already under, which reads to the shop as bad faith.
    const rivals = validRivals([row({ vendorId: "shopA", pricePerDay: 200 })], opts);
    expect(leverageIsLive({ thisShopPricePerDay: 200, rivals })).toBe(false);
    expect(leverageIsLive({ thisShopPricePerDay: 180, rivals })).toBe(false);
  });

  it("no quote from this shop yet: the card is still live", () => {
    const rivals = validRivals([row({ vendorId: "shopA", pricePerDay: 200 })], opts);
    expect(leverageIsLive({ thisShopPricePerDay: null, rivals })).toBe(true);
  });

  it("no rivals at all: nothing to point at", () => {
    expect(leverageIsLive({ thisShopPricePerDay: 250, rivals: [] })).toBe(false);
  });
});

describe("and it is wired where EVERY entry point passes through", () => {
  it("buildSession uses the aggregator, not its own inline loop", () => {
    // buildSession runs inside runSpteLiveTurn, which runThreadTurn reaches for
    // an inbound reply, a scheduled wakeup and a user action alike.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(
      /const \{ validRivals, sessionFloor \} = await import\("\.\.\/negotiation\/session-rivals"\);/
    );
    expect(live).toMatch(/rivals = validRivals\(rows, \{/);
    expect(live).toMatch(/excludeVendorId: thisVendor,\s*\n\s*currency: compareCur,\s*\n\s*limit: 4,/);
    // W5: the rental length reaches the predicate, or a per-day divided out of
    // someone's 3-day package is offered as a like-for-like rival for a 1-day
    // hire - the owner's "167" screenshot.
    expect(live).toMatch(/durationDays: input\.rfq\.durationDays,/);
    expect(live).toMatch(/lowest = sessionFloor\(rows, compareCur\);/);
    // The hand-rolled loop is gone, so there is one definition of "rival".
    expect(live).not.toMatch(/rivals\.push\(\{ vendorId: r\.vendorId/);
  });

  it("the rival's NAME still never leaves the aggregator", () => {
    // The shop name is carried for the disclosure rail to match against, and
    // the prompt builder prints prices only. Both halves have to hold.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/another shop this search: \$\{r\.pricePerDay\} \$\{r\.currency\}\/day/);
    expect(pass).not.toMatch(/\$\{r\.shop\}/);
  });
});
