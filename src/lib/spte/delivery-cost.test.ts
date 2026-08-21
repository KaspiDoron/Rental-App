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

// K-LANDING: the mode/price facts now arrive as the model's handover verdict
// (semantic/classifiers ThreadComprehension.handover -> DurableComprehension),
// projected here. The judgements the old regexes faked - "a time is not a
// price", "a daily rate in an unrelated message is not a delivery fee" - live
// in the classifier's FIFTH prompt section, pinned below.
const facts = (
  comprehension: import("./types").DurableComprehension | undefined,
  outboundKinds: string[] = []
) =>
  deriveThreadFacts({
    outbound: outboundKinds.map(() => ""),
    outboundKinds,
    priorBargainCount: 0,
    comprehension,
  });

describe("REPRODUCTION: the mode answered for the price", () => {
  it("a bare delivery offer settles the MODE", () => {
    const f = facts({ handoverMode: "delivery" });
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered).toBe(true);
  });

  it("...and does NOT settle what it costs - the whole defect", () => {
    const f = facts({ handoverMode: "delivery" });
    expect(f.fulfillmentCostKnown, "the fee is still unknown").toBe(false);
  });

  it("a stated cost (a number, or FREE) settles it", () => {
    const f = facts({ handoverMode: "delivery", handoverCostKnown: true });
    expect(f.fulfillmentCostKnown).toBe(true);
  });

  it("shop collection only is not a delivery offer", () => {
    const f = facts({ handoverMode: "pickup" });
    expect(f.fulfillmentKnown).toBe(true);
    expect(f.deliveryOffered).toBe(false);
  });

  it("no model read = nothing settled, whatever the words looked like", () => {
    const f = facts(undefined);
    expect(f.fulfillmentKnown).toBe(false);
    expect(f.fulfillmentCostKnown).toBe(false);
  });

  it("the follow-up is counted from the stamped moves, not our prose", () => {
    expect(facts(undefined, ["rfq", "fulfillment-probe"]).handoverAsks).toBe(1);
    expect(facts(undefined, ["rfq", "fulfillment-probe", "bargain", "fulfillment-probe"]).handoverAsks).toBe(2);
    expect(facts(undefined, ["rfq", "bargain"]).handoverAsks).toBe(0);
  });

  it("the CLASSIFIER owns the judgements the regexes faked", () => {
    const cls = readCode("src/lib/semantic/classifiers.ts");
    // "we deliver at 10am" must not read as a priced handover, and a daily
    // rate three messages back is not the delivery fee - the prompt states
    // both, and costStated/cost are separate schema fields from the mode.
    expect(cls).toMatch(/A daily [\s\S]{0,20}rental rate is NOT a handover cost/);
    expect(cls).toMatch(/costStated: z\.boolean\(\)/);
    expect(cls).toMatch(/mode: z\.enum\(\["delivery", "pickup", "both", "unstated"\]\)/);
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
