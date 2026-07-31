import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { isLocationLink, screenInbound, screenInboundDeterministic } from "./inbound-risk";

const mocks = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("./ai", () => ({
  chat: (...a: unknown[]) => mocks.chat(...a),
  extractJson: (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  },
}));

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

// THE FIELD FAILURE (Thailand, Bigman): the shop stated its ordinary terms -
// leave the original passport as the deposit - and the LLM half called it
// SUSPICIOUS. The code accepted that verdict with only a link filter, so the
// exact message class the deterministic half was TAUGHT to pass (F1: a
// document demand needs a transmit verb; stated terms are never a demand)
// came back as a red banner through the other door, froze the traveller's
// trust and cost a real ฿1,100 discount.
describe("the LLM half is held to the same deposit grammar", () => {
  const BIGMAN = "For rent you leave original passport for deposit. Bike ready today.";

  beforeEach(() => mocks.chat.mockReset());

  it("a model 'suspicious passport' verdict on stated deposit terms is discarded", async () => {
    mocks.chat.mockResolvedValue(
      JSON.stringify({
        risk: "high",
        reasons: ["The shop demands your passport - possible document harvesting"],
      })
    );
    const r = await screenInbound(BIGMAN, { vendorName: "Bigman" });
    expect(r.risk).toBe("none");
    expect(r.reasons).toHaveLength(0);
  });

  it("the model can still raise a NON-document risk the regexes missed", async () => {
    mocks.chat.mockResolvedValue(
      JSON.stringify({
        risk: "caution",
        reasons: ["pressures you to settle the full amount before you arrive"],
      })
    );
    const r = await screenInbound("Best you settle everything today, full amount, then we hold the bike");
    expect(r.risk).toBe("caution");
    expect(r.reasons[0]).toMatch(/full amount/);
  });

  it("the prompt itself teaches that passport-at-counter is standard practice", async () => {
    mocks.chat.mockResolvedValue(JSON.stringify({ risk: "none", reasons: [] }));
    await screenInbound(BIGMAN);
    const system = String(
      (mocks.chat.mock.calls[0]?.[0] as Array<{ content: string }>)[0]?.content ?? ""
    );
    expect(system).toMatch(/STANDARD practice/);
    expect(system).toMatch(/TRANSMIT a document over chat/);
  });

  it("an unreachable model changes nothing", async () => {
    // The real `chat` degrades rather than throwing: no provider -> "" (the
    // repo's no-key fallback rule). Unparseable output is the other shape.
    mocks.chat.mockImplementation(async () => "");
    expect((await screenInbound(BIGMAN)).risk).toBe("none");
    mocks.chat.mockImplementation(async () => "sorry, I cannot help with that");
    expect((await screenInbound(BIGMAN)).risk).toBe("none");
  });
});
