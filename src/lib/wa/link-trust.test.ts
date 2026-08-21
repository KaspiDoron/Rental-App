import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// THE FALSE FLAG (owner report 6 F). A Krabi shop shared its own Google
// listing - https://share.google/... - and the traveller got a red "don't
// enter card or account details" banner over a normal negotiation. Two
// defects: Google's current share domain was in no list, and the allow-list
// was allowed to CONDEMN hosts it merely did not know, with the model
// structurally unable to clear one ("escalate only"). The list may only ever
// CLEAR; unknown-host meaning goes to the model. Hard signals stay
// escalate-only - that rule was earned through two documented field incidents.

import { screenInboundDeterministic } from "../inbound-risk";

const KRABI_LINK =
  "Buddy Motorbike Rental บัดดี้\nhttps://share.google/M26trmq2jc5iyjg6A";

describe("the allow-list knows what Google actually emits", () => {
  it("REPRODUCTION: a share.google listing is not a phishing warning", () => {
    const r = screenInboundDeterministic(KRABI_LINK, "Buddy Motorbike Rental");
    expect(r.risk).toBe("none");
    expect(r.reasons).toEqual([]);
  });

  it("g.page and google country TLDs clear too", () => {
    for (const url of [
      "https://g.page/buddy-rental",
      "https://www.google.co.th/maps/place/x",
      "https://google.de/something",
    ]) {
      expect(screenInboundDeterministic(`our page: ${url}`).risk, url).toBe("none");
    }
  });

  it("an unknown host still raises the candidate flag deterministically", () => {
    const r = screenInboundDeterministic("pay here https://totally-legit-payments.biz/x");
    expect(r.risk).toBe("caution");
    expect(r.reasons.some((x) => x.startsWith("sent a link to"))).toBe(true);
  });
});

describe("the model may clear a LINK, never a hard signal", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/ai");
  });

  async function screenWith(modelJson: string, text: string) {
    vi.resetModules();
    vi.doMock("@/lib/ai", () => ({
      chat: async () => modelJson,
      extractJson: (s: string) => JSON.parse(s),
    }));
    const { screenInbound } = await import("@/lib/inbound-risk");
    return screenInbound(text, { vendorName: "Buddy Motorbike Rental" });
  }

  it("a confident model 'none' clears an unlisted shop site", async () => {
    const r = await screenWith(
      '{"risk":"none","reasons":[]}',
      "see our bikes at https://buddy-krabi-rentals.example"
    );
    expect(r.risk).toBe("none");
    expect(r.reasons).toEqual([]);
  });

  it("...but a card-details signal is NOT link-only and survives a model 'none'", async () => {
    // Two deterministic bumps (unknown link + card ask) escalate to HIGH,
    // which short-circuits before the model - either way, never downgraded.
    const r = await screenWith(
      '{"risk":"none","reasons":[]}',
      "type your credit card number and send it here https://buddy-krabi-rentals.example"
    );
    expect(r.risk).not.toBe("none");
    expect(r.reasons.some((x) => x.includes("card"))).toBe(true);
  });

  it("a document TRANSMIT demand never reaches the model at all", async () => {
    const r = await screenWith(
      '{"risk":"none","reasons":[]}',
      "please send a photo of your passport now"
    );
    expect(r.risk).toBe("high");
  });
});
