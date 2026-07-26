import { describe, it, expect } from "vitest";
import { deriveThreadFacts, FIRM_RX } from "./thread-facts";

describe("FIRM_RX", () => {
  it("matches the live 'last price' refusals", () => {
    expect(FIRM_RX.test("That's a last price sir 😊 I mean that's a best price for you")).toBe(true);
    expect(FIRM_RX.test("that's the cheapest we can offer sir")).toBe(true);
    expect(FIRM_RX.test("300 pesos is our last price sir")).toBe(true);
    expect(FIRM_RX.test("cannot go lower")).toBe(true);
  });
  it("does NOT treat a normal quote or a decline as firm", () => {
    expect(FIRM_RX.test("yes sir it's only 400/ day for you")).toBe(false);
    expect(FIRM_RX.test("sorry we have no scooter available")).toBe(false);
  });
});

describe("deriveThreadFacts - the John Motor Rental transcript", () => {
  // The exact escalation from the screenshot: agent pushed 330 -> 320 -> 280
  // and the shop said "last price" twice.
  const inbound = [
    "Even 350 pesos per day is okay sir. Just let us know your hotel and delivery time. Thank you",
    "Okay let's do that sir 330/day 🙂",
    "That's ok sir. Around what time?",
    "Closed deal sir 300 pesos a day, free delivery",
    "That's a last price sir 😊 I mean that's a best price for you",
  ];
  const outbound = [
    "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 330 PHP/day?",
    "thanks for the offer! Since I'm booking for 4 days, can u give me an even better deal, like 320 PHP/day?",
    "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 280 PHP/day?",
  ];

  it("counts the firm refusal and detects free delivery", () => {
    const f = deriveThreadFacts({
      inbound,
      outbound,
      currentInbound: "That's a last price sir 😊 I mean that's a best price for you",
    });
    expect(f.firmCount).toBeGreaterThanOrEqual(1);
    expect(f.fulfillmentKnown).toBe(true); // "free delivery"
    expect(f.bargainRounds).toBeGreaterThanOrEqual(3); // three real pushes
    expect(f.lastOutbound.length).toBe(3);
  });

  it("reaches firmCount 2 when the shop repeats the last-price line", () => {
    const f = deriveThreadFacts({
      inbound: [...inbound, "Hello sir? That's a last price sir 😊 I mean that's a best price for you"],
      outbound,
    });
    expect(f.firmCount).toBeGreaterThanOrEqual(2);
  });
});

describe("deriveThreadFacts - deposit + pickup", () => {
  it("detects a passport/deposit answer and shop pickup", () => {
    const f = deriveThreadFacts({
      inbound: ["We need a passport as deposit sir, and you can pick up at our shop"],
      outbound: [],
    });
    expect(f.depositKnown).toBe(true);
    expect(f.fulfillmentKnown).toBe(true);
  });
  it("is empty on a fresh thread", () => {
    const f = deriveThreadFacts({ inbound: [], outbound: [] });
    expect(f).toEqual({
      firmCount: 0,
      depositKnown: false,
      fulfillmentKnown: false,
      bargainRounds: 0,
      lastOutbound: [],
    });
  });
});

describe("deriveThreadFacts - round healing", () => {
  it("honors the caller count and de-dupes the current inbound", () => {
    const f = deriveThreadFacts({
      inbound: ["last price sir"],
      outbound: ["can you do 300/day?"],
      currentInbound: "last price sir", // already the last stored -> not double counted
      priorBargainCount: 5,
    });
    expect(f.firmCount).toBe(1);
    expect(f.bargainRounds).toBe(5); // caller count wins when higher
  });
});
