import { describe, it, expect, vi } from "vitest";

// THE LLM-DOWN ANSWER TO "WHERE ARE YOU STAYING?".
//
// `fallbackArtifact` is what a turn becomes when every provider is down or
// returns garbage. It walks the legal ladder and takes the first move with a
// safe template - and `pickup-location` HAS one, built only from the consented
// disclosure gate (`ctx.share`), never from the shop's message or a model. An
// outage must not turn "can you deliver to my hotel?" into silence; and the
// absence of consent must not turn it into an improvised address.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  extractJson: () => null,
}));

import { fallbackArtifact } from "./pass";
import { emptyDigest } from "./digest";
import type { TurnContext, VerifiedExtraction } from "./types";

function ctx(partial: Partial<TurnContext> & { verified: VerifiedExtraction }): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: { vehicleClass: "scooter", engineSizeCc: 125, transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
      currency: "PHP",
      benchmark: null,
      lowest: null,
      rivals: [],
      ...(partial.session ?? {}),
    },
    thread: {
      threadKey: "u:63",
      vendorId: "v1",
      shop: "Shop A",
      digest: emptyDigest(),
      ...(partial.thread ?? {}),
    },
    tail: [],
    inbound: { text: "", verified: partial.verified },
    legalMoves: partial.legalMoves ?? [],
    guards: { maxRounds: 4, ...(partial.guards ?? {}) },
    event: "shop-message",
    ...(partial.share ? { share: partial.share } : {}),
  };
}

describe("the deterministic pickup-location template (LLM outage path)", () => {
  it("answers 'where are you' with the CONSENTED address and pin", () => {
    const c = ctx({
      verified: { found: false, askedLocation: true },
      legalMoves: ["pickup-location", "answer", "silent"],
      share: { addressText: "Ao Nang Beach Resort, Krabi", mapsLink: "https://maps.app.goo.gl/abc" },
    });
    const art = fallbackArtifact(c);
    expect(art.move).toBe("pickup-location");
    expect(art.message).toContain("Ao Nang Beach Resort, Krabi");
    expect(art.message).toContain("https://maps.app.goo.gl/abc");
  });

  it("without a maps pin the sentence still stands on the address alone", () => {
    const c = ctx({
      verified: { found: false, askedLocation: true },
      legalMoves: ["pickup-location", "silent"],
      share: { addressText: "Ao Nang Beach Resort, Krabi" },
    });
    const art = fallbackArtifact(c);
    expect(art.move).toBe("pickup-location");
    expect(art.message).toContain("I'm staying at Ao Nang Beach Resort, Krabi");
    expect(art.message).not.toContain("(");
  });

  it("with NO consented stay the template refuses - the ladder falls through, never improvising", () => {
    // policy.ts already keeps pickup-location out of legalMoves without a
    // verified stay; this pins the second lock on the same door - even if the
    // move somehow reached the template, no address exists to leak, and the
    // shop still gets the next safe answer instead of silence.
    const c = ctx({
      verified: { found: false, askedLocation: true },
      legalMoves: ["pickup-location", "answer", "silent"],
    });
    const art = fallbackArtifact(c);
    expect(art.move).toBe("answer");
    expect(art.message).toBeTruthy();
    expect(art.message).not.toContain("staying at");
  });
});
