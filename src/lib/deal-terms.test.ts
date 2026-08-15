import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  termsComplete,
  priceKnown,
  depositKnown,
  fulfillmentOf,
  fulfillmentKnown,
  missingTerms,
  depositPhrase,
  fulfillmentLabel,
} from "./deal-terms";
import { moneyLocal } from "./currency";

// W6.1 - THE PREDICATE THE OWNER ASKED FOR, WHICH EXISTED TWICE AND WAS
// REACHABLE FROM NEITHER PLACE.
//
// Owner: re-ask the shops of an old hunt "ONLY if we have price, deposit and
// how we get the vehicle details". That rule was already written as a local
// closure inside /api/replies (unexported) and as the reasoning behind SPTE's
// `present` move - so the Trips re-check, the one surface that most needed it,
// had no way to ask and messaged every shop it had ever contacted, answered or
// not. One definition now, shared.

describe("the three facts that make a deal", () => {
  it("needs all three - none of them alone is enough", () => {
    expect(termsComplete({ pricePerDay: 300 })).toBe(false);
    expect(termsComplete({ pricePerDay: 300, depositType: "cash" })).toBe(false);
    expect(termsComplete({ pricePerDay: 300, fulfillment: "pickup" })).toBe(false);
    expect(termsComplete({ depositType: "cash", fulfillment: "pickup" })).toBe(false);
    expect(termsComplete({ pricePerDay: 300, depositType: "cash", fulfillment: "pickup" })).toBe(true);
  });

  it("a zero or missing price is not a quote", () => {
    expect(priceKnown({ pricePerDay: 0 })).toBe(false);
    expect(priceKnown({ pricePerDay: -5 })).toBe(false);
    expect(priceKnown({})).toBe(false);
    expect(priceKnown({ pricePerDay: 1 })).toBe(true);
  });

  it('"no deposit" IS an answer - the friendliest shops must not be excluded', () => {
    expect(depositKnown({ depositType: "none" })).toBe(true);
    expect(depositKnown({})).toBe(false);
    expect(depositKnown({ depositNote: "passport until you return it" })).toBe(true);
    expect(depositKnown({ depositLabel: "2000 baht" })).toBe(true);
    expect(depositKnown({ depositAmount: 2000 })).toBe(true);
    // An empty string is not a statement.
    expect(depositKnown({ depositType: "  " })).toBe(false);
  });

  it("the engine's fulfillment wins, and `delivers` settles only its own half", () => {
    expect(fulfillmentOf({ fulfillment: "delivery" })).toBe("delivery");
    expect(fulfillmentOf({ fulfillment: "on-shop" })).toBe("on-shop");
    // "we do not deliver" answers the question: you come to the shop.
    expect(fulfillmentOf({ delivers: false })).toBe("pickup");
    expect(fulfillmentOf({ delivers: true })).toBe("delivery");
    // Silence is not an answer.
    expect(fulfillmentOf({})).toBeNull();
    expect(fulfillmentOf({ delivers: null })).toBeNull();
    expect(fulfillmentKnown({ fulfillment: "banana" })).toBe(false);
  });

  it("names exactly what is missing, for honest UI copy", () => {
    expect(missingTerms({})).toEqual(["price", "deposit", "fulfillment"]);
    expect(missingTerms({ pricePerDay: 300, depositType: "cash" })).toEqual(["fulfillment"]);
    expect(missingTerms({ pricePerDay: 300, depositType: "cash", delivers: true })).toEqual([]);
  });
});

describe("the terms as words a shop would recognise", () => {
  it("states a cash deposit with the shop's own figure", () => {
    expect(depositPhrase({ depositType: "cash", depositAmount: 2000, depositCurrency: "THB" }, moneyLocal))
      .toMatch(/2,?000/);
  });
  it("does not turn a passport into a number", () => {
    expect(depositPhrase({ depositType: "passport" })).toMatch(/passport/i);
  });
  // ...AND DOES NOT TURN A CHOICE INTO A DEMAND (the owner's report).
  //
  // The old body was `if (type === passport|id|document) return "a passport/ID
  // deposit"` - a return that could not, by construction, mention the cash the
  // shop had also offered. This phrase is spoken TO THE SHOP by the Trips
  // re-check, so the missing half was not a display bug: it confirmed terms
  // nobody offered. Every alternative, or we are inventing the deal.
  it("keeps EVERY alternative the shop named - passport OR cash", () => {
    const said = depositPhrase(
      {
        depositType: "passport",
        depositAmount: 4000,
        depositCurrency: "THB",
        depositNote: "We have deposit passport or money4000",
      },
      moneyLocal
    )!;
    expect(said).toMatch(/passport/i);
    expect(said).toMatch(/4,?000/);
    expect(said).toMatch(/\bor\b/);
  });
  it("keeps a BUNDLE a bundle - a copy plus cash is not a choice", () => {
    const said = depositPhrase(
      { depositNote: "Copy of passport + 3000 THB", depositType: "passport" },
      moneyLocal
    )!;
    expect(said).toMatch(/copy/i);
    expect(said).toMatch(/3,?000/);
    // "or" would tell the traveller they may pick one. They may not.
    expect(said).not.toMatch(/\bor\b/);
  });
  it("says 'no deposit' plainly", () => {
    expect(depositPhrase({ depositType: "none" })).toBe("no deposit");
  });
  it("falls back to the shop's own words, bounded", () => {
    const long = "x".repeat(200);
    expect(depositPhrase({ depositNote: long })!.length).toBeLessThanOrEqual(60);
  });
  it("has nothing to say when nothing was said", () => {
    expect(depositPhrase({})).toBeNull();
    expect(fulfillmentLabel({})).toBeNull();
  });
  it("labels the screen differently from the message", () => {
    expect(fulfillmentLabel({ fulfillment: "delivery" })).toBe("Delivered to you");
    expect(fulfillmentLabel({ fulfillment: "on-shop" })).toBe("Pick-up at the shop");
  });
});

// ---------------------------------------------------------------------------
// THE WIRING - one definition, actually used where it matters.
// ---------------------------------------------------------------------------

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the predicate is shared, not re-implemented", () => {
  it("/api/replies uses it instead of its own closure", () => {
    const code = readCode("src/app/api/replies/route.ts");
    expect(code).toMatch(/from "@\/lib\/deal-terms"/);
    expect(code).toMatch(/termsComplete\(/);
  });

  it("the Trips re-check FILTERS on it before it messages anyone", () => {
    const code = readCode("src/app/api/deals/recheck/route.ts");
    expect(code).toMatch(/termsComplete\(termsFor\(/);
  });

  it("the Trips list counts re-checkable shops with the same predicate", () => {
    const code = readCode("src/app/api/deals/route.ts");
    expect(code).toMatch(/filter\(termsComplete\)/);
    expect(code).toMatch(/recheckable/);
  });
});
