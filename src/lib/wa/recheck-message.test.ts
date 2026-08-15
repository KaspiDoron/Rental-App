import { describe, it, expect } from "vitest";
import { recheckMessage } from "./recheck-message";

// Coming back to a past hunt asks every shop one question. The numbers in that
// question are the SHOP'S OWN - never ones we made up - and the question is
// about the whole deal, not only the price.
//
// W6.1 CHANGED THE SPEC HERE, AND THE OLD SUITE LOCKED THE OLD ONE IN.
//
// The owner: re-ask "if the price is still available for renting on the same
// conditions, ONLY if we have price, deposit and how we get the vehicle
// details". The previous message named only the price and had an explicit
// no-price branch ("is the rate we discussed still available?") - and the test
// below used to ASSERT that branch, so the spec was contradicted by the suite
// as well as by the code. It is now the opposite assertion: no full terms, no
// message at all.

const full = {
  pricePerDay: 400,
  currency: "PHP",
  depositType: "cash",
  depositAmount: 2000,
  depositCurrency: "PHP",
  fulfillment: "pickup",
};

describe("the re-check message", () => {
  it("reads the shop's own price back to them", () => {
    const m = recheckMessage({ ...full, days: 5 })!;
    expect(m).toContain("400");
    expect(m).toMatch(/5 days/);
    expect(m).toMatch(/still available/i);
  });

  it("restates the CONDITIONS, not just the price", () => {
    const m = recheckMessage({ ...full, days: 5 })!;
    expect(m).toMatch(/2,?000/); // the deposit, in the shop's own figure
    expect(m).toMatch(/deposit/i);
    expect(m).toMatch(/pick-?up at your shop/i);
  });

  it("says delivery when that is how the shop hands it over", () => {
    const m = recheckMessage({ ...full, fulfillment: "delivery" })!;
    expect(m).toMatch(/delivery to me/i);
    expect(m).not.toMatch(/pick-?up/i);
  });

  it("carries a passport deposit as a passport, not as a sum", () => {
    const m = recheckMessage({ ...full, depositType: "passport", depositAmount: null })!;
    expect(m).toMatch(/passport/i);
  });

  // THE OWNER'S REPORT, IN THE PLACE IT DOES THE MOST DAMAGE.
  //
  // A shop wrote "We have deposit passport or money4000" and the app showed
  // "Passport deposit". Worse than a display bug: this sentence is SENT TO THE
  // SHOP, so a dropped alternative is us confirming terms they never offered -
  // and the dropped half is the one that lets the traveller keep their passport.
  // `depositPhrase` returned "a passport/ID deposit" for anything document-shaped
  // and threw the cash route away; both halves have to survive the trip.
  it("THE OWNER'S CASE: 'passport or money4000' is read back with BOTH options", () => {
    const m = recheckMessage({
      ...full,
      depositType: "passport",
      depositAmount: 4000,
      depositCurrency: "THB",
      depositNote: "We have deposit passport or money4000",
    })!;
    expect(m).toMatch(/passport/i);
    expect(m).toMatch(/4,?000/);
    expect(m).toMatch(/\bor\b/);
  });

  it("...and with the raw words lost, the flat type+amount pair still says both", () => {
    // Older rows carry only the enum and the number. `passport` + 4000 is the
    // same offer with its sentence missing, and saying one half is still wrong.
    const m = recheckMessage({
      ...full,
      depositType: "passport",
      depositAmount: 4000,
      depositCurrency: "THB",
    })!;
    expect(m).toMatch(/passport/i);
    expect(m).toMatch(/4,?000/);
  });

  it("a shop that takes NO deposit has still answered the question", () => {
    const m = recheckMessage({ ...full, depositType: "none", depositAmount: null })!;
    expect(m).toMatch(/no deposit/i);
  });

  it("REFUSES when the shop never gave a price", () => {
    // The old behaviour was a "the rate we discussed" message to a shop we knew
    // nothing about. There is no such sentence any more.
    expect(recheckMessage({ ...full, pricePerDay: null, days: 5 })).toBeNull();
  });

  it("REFUSES when the deposit was never stated", () => {
    expect(
      recheckMessage({
        pricePerDay: 400,
        currency: "PHP",
        fulfillment: "pickup",
      })
    ).toBeNull();
  });

  it("REFUSES when nobody said how the traveller gets the vehicle", () => {
    expect(
      recheckMessage({ pricePerDay: 400, currency: "PHP", depositType: "cash", depositAmount: 2000 })
    ).toBeNull();
  });

  it("says nothing about a duration we do not know", () => {
    expect(recheckMessage(full)!).not.toMatch(/for \d+ days/);
  });

  it("never treats a zero or negative price as a quote", () => {
    for (const p of [0, -1]) {
      expect(recheckMessage({ ...full, pricePerDay: p })).toBeNull();
    }
  });

  it("stays short and human - two sentences, no wall of text", () => {
    const m = recheckMessage({ ...full, days: 5 })!;
    expect(m.length).toBeLessThan(220);
    expect(m.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(3);
  });

  it("opens with no greeting - it lands inside an existing thread", () => {
    const m = recheckMessage({ ...full, days: 3 })!;
    expect(m).not.toMatch(/^(hi|hey|hello)\b/i);
  });
});
