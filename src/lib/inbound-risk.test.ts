import { describe, it, expect } from "vitest";
import { screenInboundDeterministic } from "./inbound-risk";

describe("inbound risk screen (deterministic)", () => {
  it("normal haggling is clean", () => {
    expect(screenInboundDeterministic("Yes have 125cc, 180 per day, helmet included").risk).toBe("none");
    expect(screenInboundDeterministic("Deposit 3000 baht cash when you pick up").risk).toBe("none");
  });

  it("passport photo demand is HIGH", () => {
    const r = screenInboundDeterministic("Ok but first send photo of your passport to confirm booking");
    expect(r.risk).toBe("high");
    expect(r.reasons[0]).toMatch(/passport/i);
  });

  it("bank transfer before viewing is HIGH", () => {
    const r = screenInboundDeterministic("You must pay deposit by bank transfer first to secure the bike");
    expect(r.risk).toBe("high");
  });

  it("unknown link is a caution; maps/wa links are fine", () => {
    expect(screenInboundDeterministic("Our location https://maps.google.com/?q=1,2").risk).toBe("none");
    const r = screenInboundDeterministic("Book here http://cheap-bali-rentals.xyz/pay");
    expect(r.risk).toBe("caution");
  });

  it("card details over chat is HIGH", () => {
    expect(screenInboundDeterministic("Just send your card number and cvv, we charge deposit").risk).toBe("high");
  });

  it("number-switch request is a caution", () => {
    expect(
      screenInboundDeterministic("Please message this other number 6281234567 for booking").risk
    ).toBe("caution");
  });
});
