import { describe, it, expect } from "vitest";
import {
  applyExtractionToState,
  dealComplete,
  derivePhase,
  missingFields,
  newThreadState,
} from "./state";
import { computeRoundTarget } from "./math";
import { ensureGloballyFresh, trigramOverlap, enforceEmojiTone } from "./uniqueness";
import type { ExtractedOffer } from "../agents";

function extraction(over: Partial<ExtractedOffer> = {}): ExtractedOffer {
  return { found: true, matchesSpec: true, confidence: "high", ...over };
}

const fresh = () =>
  newThreadState({ threadKey: "u@x:66123", userEmail: "u@x", toNumber: "66123", vendorId: "v1" });

describe("thread state - deal completeness", () => {
  it("a bare price is not complete - deposit + fulfillment still missing", () => {
    const s = applyExtractionToState(fresh(), extraction({ pricePerDay: 250 }), 250, "THB");
    expect(dealComplete(s.fields)).toBe(false);
    expect(missingFields(s.fields).sort()).toEqual(["deposit", "fulfillment"]);
    expect(s.phase).toBe("negotiating");
  });

  it("price + cash deposit + delivery = complete", () => {
    let s = applyExtractionToState(fresh(), extraction({ pricePerDay: 250 }), 250, "THB");
    s = applyExtractionToState(
      s,
      extraction({ depositType: "cash", depositAmount: 3000, delivers: true }),
      250,
      "THB"
    );
    expect(dealComplete(s.fields)).toBe(true);
    expect(s.fields.fulfillment).toBe("delivery");
    expect(derivePhase(s)).toBe("complete");
  });

  it("passport deposit is recorded and flagged for the cash push", () => {
    const s = applyExtractionToState(
      fresh(),
      extraction({ pricePerDay: 200, depositType: "passport" }),
      200,
      "THB"
    );
    expect(s.fields.depositType).toBe("passport");
    expect(s.fields.cashAlternativeAsked).toBeFalsy();
  });

  it("pickup offer sets pickup fulfillment", () => {
    const s = applyExtractionToState(
      fresh(),
      extraction({ pricePerDay: 200, pickupOffered: true }),
      200,
      "THB"
    );
    expect(s.fields.pickupOffered).toBe(true);
    expect(s.fields.fulfillment).toBe("pickup");
  });

  it("on-shop only is recorded", () => {
    const s = applyExtractionToState(
      fresh(),
      extraction({ pricePerDay: 200, onShopOnly: true }),
      200,
      "THB"
    );
    expect(s.fields.fulfillment).toBe("on-shop");
  });

  it("firmness and annoyance accumulate", () => {
    let s = applyExtractionToState(fresh(), extraction({ pricePerDay: 200, shopFirm: true }), 200, "THB");
    expect(s.fields.firmCount).toBe(1);
    s = applyExtractionToState(s, extraction({ pricePerDay: 200, shopFirm: true, shopTone: "annoyed" }), 200, "THB");
    expect(s.fields.firmCount).toBe(2);
    expect(s.fields.toneDegraded).toBe(true);
  });
});

describe("concession ladder (computeRoundTarget)", () => {
  it("first ask anchors toward the floor", () => {
    const t = computeRoundTarget({ quoted: 500, floorPrice: 250, rounds: 0 });
    expect(t).toBeGreaterThanOrEqual(250);
    expect(t).toBeLessThan(500);
  });
  it("second ask softens (meets between quote and last ask)", () => {
    const t = computeRoundTarget({ quoted: 400, floorPrice: 250, rounds: 1, lastTarget: 300 });
    expect(t).toBeGreaterThanOrEqual(250);
    expect(t).toBeLessThan(400);
  });
  it("never asks at or above the quote (returns undefined)", () => {
    const t = computeRoundTarget({ quoted: 150, floorPrice: 150, rounds: 0 });
    expect(t).toBeUndefined();
  });
  it("a cheaper rival caps the ask", () => {
    const t = computeRoundTarget({ quoted: 500, floorPrice: 200, rivalPrice: 300, rounds: 0 });
    expect(t).toBeLessThanOrEqual(300);
  });
  it("round 0 asks the REAL floor itself (the playbook opener)", () => {
    expect(computeRoundTarget({ quoted: 300, floorPrice: 160, rounds: 0 })).toBe(160);
  });
  it("round 1 comes back ~15% above the floor, as a clean round number", () => {
    const t = computeRoundTarget({ quoted: 300, floorPrice: 160, rounds: 1, lastTarget: 160 });
    expect(t).toBe(185); // 160 * 1.15 = 184 -> nice 185
  });
  it("never re-asks below an earlier ask (the ladder concedes upward)", () => {
    const t = computeRoundTarget({ quoted: 300, floorPrice: 100, rounds: 1, lastTarget: 200 });
    expect(t).toBeGreaterThanOrEqual(200);
  });
});

describe("global uniqueness", () => {
  it("identical text overlaps fully", () => {
    expect(trigramOverlap("what is your best price", "what is your best price")).toBe(1);
  });
  it("different messages overlap little", () => {
    const o = trigramOverlap(
      "can you deliver to my hotel please",
      "what deposit do you need for the scooter"
    );
    expect(o).toBeLessThan(0.5);
  });
  it("a colliding draft is mutated until fresh", () => {
    const prior = ["okay what deposit do you need for it"];
    const r = ensureGloballyFresh("okay what deposit do you need for it", prior);
    expect(r.changed).toBe(true);
    expect(r.text).not.toBe("okay what deposit do you need for it");
  });
  it("emoji tone adds exactly one emoji when missing", () => {
    const out = enforceEmojiTone("what is your best price", true);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out)).toBe(true);
  });
});

describe("re-engagement - a declined thread is not a permanent dead end", () => {
  it("reopens when the shop returns with a concrete new price", () => {
    let s = applyExtractionToState(
      fresh(),
      extraction({ pricePerDay: 300, shopDeclined: true }),
      300,
      "THB"
    );
    s = { ...s, phase: "dead" }; // the pipeline marks a declined thread dead
    expect(s.fields.declined).toBe(true);
    // "ok ok, 250 is fine, come" - a concrete number is a re-engagement signal.
    s = applyExtractionToState(s, extraction({ pricePerDay: 250 }), 250, "THB");
    expect(s.fields.declined).toBe(false);
    expect(s.phase).not.toBe("dead");
    expect(["negotiating", "collecting_terms", "complete"]).toContain(s.phase);
  });

  it("does NOT reopen on a bare no-price reply", () => {
    let s = applyExtractionToState(
      fresh(),
      extraction({ pricePerDay: 300, shopDeclined: true }),
      300,
      "THB"
    );
    s = { ...s, phase: "dead" };
    s = applyExtractionToState(s, extraction({ shopTone: "annoyed" }), undefined, "THB");
    expect(s.phase).toBe("dead");
    expect(s.fields.declined).toBe(true);
  });

  it("never reopens a closed (won) deal", () => {
    let s = applyExtractionToState(fresh(), extraction({ pricePerDay: 250 }), 250, "THB");
    s = { ...s, phase: "closed" };
    s = applyExtractionToState(s, extraction({ pricePerDay: 240 }), 240, "THB");
    expect(s.phase).toBe("closed");
  });
});
