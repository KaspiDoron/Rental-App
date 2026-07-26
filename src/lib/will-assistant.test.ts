import { describe, it, expect } from "vitest";
import { deriveWillStep, placeBubble, type WillStepInput } from "./will-assistant";

const base: WillStepInput = {
  waConnected: true,
  waPhase: null,
  phase: "idle",
  vendorCount: 0,
  offerCount: 0,
  closing: false,
};

describe("deriveWillStep", () => {
  it("says NOTHING while the link status is still unknown", () => {
    expect(deriveWillStep({ ...base, waConnected: null })).toBeNull();
  });

  it("walks the whole funnel in order", () => {
    expect(deriveWillStep({ ...base, waConnected: false })).toBe("WA_LINK_PENDING");
    expect(deriveWillStep({ ...base, waConnected: false, waPhase: "AUTHENTICATING" })).toBe(
      "WA_AUTHENTICATING"
    );
    expect(deriveWillStep(base)).toBe("SEARCH_INPUT");
    expect(deriveWillStep({ ...base, phase: "profiling" })).toBe("AGENTS_DISPATCHED");
    expect(deriveWillStep({ ...base, phase: "running" })).toBe("AGENTS_DISPATCHED");
    expect(deriveWillStep({ ...base, phase: "done", vendorCount: 8 })).toBe("NEGOTIATING");
    expect(deriveWillStep({ ...base, phase: "done", vendorCount: 8, offerCount: 2 })).toBe(
      "RESULTS_READY"
    );
    expect(deriveWillStep({ ...base, vendorCount: 8, closing: true })).toBe("RESULTS_READY");
  });

  it("an unlinked user is ALWAYS on the link step, whatever else is going on", () => {
    expect(
      deriveWillStep({ ...base, waConnected: false, vendorCount: 9, offerCount: 3, closing: true })
    ).toBe("WA_LINK_PENDING");
  });
});

describe("placeBubble", () => {
  const vp = { width: 390, height: 844 }; // iPhone-ish
  const bubble = { width: 300, height: 96 };

  it("prefers ABOVE the anchor when there is headroom", () => {
    const p = placeBubble({ top: 500, left: 45, width: 300, height: 48 }, bubble, vp);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(500 - 10 - 96);
  });

  it("falls below when the anchor is near the top", () => {
    const p = placeBubble({ top: 40, left: 45, width: 300, height: 48 }, bubble, vp);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(40 + 48 + 10);
  });

  it("clamps horizontally and keeps the arrow on the anchor", () => {
    // Anchor hugging the left edge: the card clamps to the margin...
    const p = placeBubble({ top: 500, left: 0, width: 44, height: 44 }, bubble, vp);
    expect(p.left).toBe(12);
    // ...but the arrow still points at the anchor center (22px), clamped to the
    // 18px minimum inset so it never escapes the card.
    expect(p.arrowLeft).toBe(18);
  });

  it("never renders off the bottom of the viewport", () => {
    const p = placeBubble({ top: 830, left: 45, width: 300, height: 48 }, bubble, vp);
    expect(p.top + bubble.height).toBeLessThanOrEqual(vp.height - 12);
  });
});
