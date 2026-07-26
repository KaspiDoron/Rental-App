import { describe, it, expect } from "vitest";
import { isLocationLink, screenInboundDeterministic } from "./inbound-risk";

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

// The live Krabi thread: a shop answered "You can try & choose here
// https://maps.app.goo.gl/..." and the app flagged it as risky. The host was
// ALREADY on the allow-list - the flag came from the LLM half, whose verdict
// overrode the deterministic one through a tautology.
describe("a map pin is an answer, not a lure", () => {
  it("clears an allow-listed maps link deterministically", () => {
    const r = screenInboundDeterministic(
      "You can try & choose here https://maps.app.goo.gl/b96ZVnVGdCLn71AF9?g_st=ic"
    );
    expect(r.risk).toBe("none");
    expect(r.clearedHosts).toContain("maps.app.goo.gl");
  });

  it("clears map hosts that are not on the list at all", () => {
    expect(screenInboundDeterministic("https://maps.apple.com/?ll=8.0,98.8").risk).toBe("none");
    expect(isLocationLink("https://www.waze.com/ul?ll=8.0,98.8")).toBe(true);
    expect(isLocationLink("https://pay-now-secure.example.com/card")).toBe(false);
  });

  it("still flags a genuinely unknown link", () => {
    const r = screenInboundDeterministic("pay here https://secure-rental-pay.top/checkout");
    expect(r.risk).toBe("caution");
  });

  it("a real danger is still HIGH even alongside a safe map pin", () => {
    const r = screenInboundDeterministic(
      "send a photo of your passport first, then https://maps.app.goo.gl/xyz"
    );
    expect(r.risk).toBe("high");
  });
});
