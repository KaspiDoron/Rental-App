import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveThreadFacts } from "./thread-facts";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "YES, WE DELIVER TO YOUR HOTEL" CLOSED THE SUBJECT (item 15).
//
// `fulfillmentKnown` went true the instant a shop's message matched
// FULFILLMENT_RX - which contains the bare word "deliver". The handover probe
// is gated on `!fulfillmentKnown`, so one friendly "we can deliver" retired it
// permanently and the FEE was never asked.
//
// That is the worst possible thing for this product to not ask. The traveller
// compares per-day rates across a dozen shops, picks the cheapest, and meets a
// delivery charge at handover - the one number a price-comparison app exists to
// surface BEFORE the choice rather than after it. And the mirror question -
// "would collecting it at the shop be cheaper?" - was closed by the same flag.
//
// The mode and its price are two facts. One flag was answering for both.

const facts = (inbound: string[], outboundKinds: string[] = []) =>
  deriveThreadFacts({
    inbound,
    outbound: outboundKinds.map(() => ""),
    outboundKinds,
    currentInbound: "",
    priorBargainCount: 0,
  });

describe("REPRODUCTION: the mode answered for the price", () => {
  it("a bare delivery offer settles the MODE", () => {
    const f = facts(["Yes we can deliver to your hotel"]);
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered).toBe(true);
  });

  it("...and does NOT settle what it costs - the whole defect", () => {
    const f = facts(["Yes we can deliver to your hotel"]);
    expect(f.fulfillmentCostKnown, "the fee is still unknown").toBe(false);
  });

  it("a number in the handover message settles it", () => {
    for (const m of [
      "We deliver to your hotel, 100 baht",
      "Delivery is ฿150",
      "We can bring it over for 200 THB",
    ]) {
      expect(facts([m]).fulfillmentCostKnown, m).toBe(true);
    }
  });

  it("and so does FREE - the friendliest terms must not be asked about forever", () => {
    for (const m of [
      "We deliver free to your hotel",
      "Delivery is included",
      "We can bring it, no charge",
    ]) {
      expect(facts([m]).fulfillmentCostKnown, m).toBe(true);
    }
  });

  it("a daily rate in an UNRELATED message is not a delivery fee", () => {
    // The rate was quoted in its own message; the delivery offer carries no
    // number. Reading the two together is how a 250/day quote would be filed
    // as a 250 delivery charge and nobody would ever ask again.
    const f = facts(["250 per day", "Yes we deliver to your hotel"]);
    expect(f.fulfillmentCostKnown).toBe(false);
  });

  it("a time is not a price", () => {
    // "we deliver at 10am" is the single most likely sentence to be misread as
    // a priced handover.
    expect(facts(["We can deliver at 10am"]).fulfillmentCostKnown).toBe(false);
    expect(facts(["We deliver at 9 o'clock"]).fulfillmentCostKnown).toBe(false);
  });

  it("shop collection only is not a delivery offer", () => {
    // Nothing to price, so no follow-up is due.
    const f = facts(["You can pick it up at our shop"]);
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered).toBe(false);
  });

  it("the follow-up is counted from the stamped moves, not our prose", () => {
    expect(facts(["ok"], ["rfq", "fulfillment-probe"]).handoverAsks).toBe(1);
    expect(facts(["ok"], ["rfq", "fulfillment-probe", "bargain", "fulfillment-probe"]).handoverAsks).toBe(2);
    expect(facts(["ok"], ["rfq", "bargain"]).handoverAsks).toBe(0);
  });
});

describe("the follow-up is due once, and asks a DIFFERENT question", () => {
  const policy = readCode("src/lib/spte/policy.ts");
  const pass = readCode("src/lib/spte/pass.ts");

  it("it is legal only after the mode was asked and the shop offered delivery", () => {
    expect(policy).toMatch(/if \(d\.fulfillmentCostKnown === true\) return false;/);
    expect(policy).toMatch(/if \(d\.deliveryOffered !== true\) return false;/);
    expect(policy).toMatch(/asked >= 1/);
  });

  it("and it stops - a shop that will not answer is not asked a third time", () => {
    expect(policy).toMatch(/HANDOVER_COST_ASKS_MAX = 1/);
    expect(policy).toMatch(/asked <= HANDOVER_COST_ASKS_MAX/);
  });

  it("the deterministic template does not re-send the first question", () => {
    // Without this the follow-up asks "do you deliver?" of a shop that has just
    // said it delivers - which is the repeat the whole gate exists to prevent.
    const at = pass.indexOf('case "fulfillment-probe":');
    const body = pass.slice(at, at + 900);
    expect(body).toMatch(/deliveryOffered === true/);
    expect(body).toMatch(/charge for delivery/i);
    // It offers collection in the same breath, so one reply can settle both.
    expect(body).toMatch(/collect it from the shop/i);
  });

  it("the glossary the model reads carries both questions", () => {
    expect(readCode("src/lib/spte/moves.ts")).toMatch(/delivery CHARGE/);
  });

  it("knowing HOW is not OR-ed into knowing HOW MUCH", () => {
    // The ledger's "handover" subject settles the mode. Folding it into the
    // cost flag would re-create the original bug one layer up.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/fulfillmentCostKnown: facts\.fulfillmentCostKnown,/);
    expect(live).not.toMatch(
      /fulfillmentCostKnown:[^\n]*ledger\.known\.includes\("handover"\)/
    );
  });
});
