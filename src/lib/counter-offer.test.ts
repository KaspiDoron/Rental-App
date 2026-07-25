import { describe, it, expect } from "vitest";
import { deriveCountered } from "./counter-offer";

const T = (s: string) => `2026-07-25T10:${s}:00Z`;

describe("deriveCountered - data-driven counter-offer stage (J)", () => {
  it("quote then a bargain after it => countered", () => {
    const out = deriveCountered({
      offers: [{ vendor_id: "v1", round: 0, created_at: T("00") }],
      replies: [{ vendor_id: "v1", created_at: T("00") }],
      outbound: [{ raw: { vendorId: "v1", kind: "auto-bargain" }, received_at: T("05") }],
    });
    expect(out).toEqual(["v1"]);
  });

  it("a quote with NO counter yet stays out (offer-received, not counter-offer)", () => {
    const out = deriveCountered({
      offers: [{ vendor_id: "v1", round: 0, created_at: T("00") }],
      replies: [{ vendor_id: "v1", created_at: T("00") }],
      outbound: [{ raw: { vendorId: "v1", kind: "rfq" }, received_at: T("05") }],
    });
    expect(out).toEqual([]);
  });

  it("an offer row with round>=1 alone is enough (re-quote after our ask)", () => {
    const out = deriveCountered({
      offers: [{ vendor_id: "v2", round: 1, created_at: T("10") }],
      replies: [],
      outbound: [],
    });
    expect(out).toEqual(["v2"]);
  });

  it("a bargain BEFORE any inbound quote does NOT count (a counter needs a quote to counter)", () => {
    const out = deriveCountered({
      offers: [],
      replies: [{ vendor_id: "v3", created_at: T("30") }],
      // outbound bargain timestamped before the reply - cannot be a response to it
      outbound: [{ raw: { vendorId: "v3", kind: "bargain" }, received_at: T("20") }],
    });
    expect(out).toEqual([]);
  });

  it("ignores rows with no vendor id and non-bargain kinds", () => {
    const out = deriveCountered({
      offers: [{ vendor_id: null, round: 3, created_at: T("00") }],
      replies: [{ vendor_id: "v4", created_at: T("00") }],
      outbound: [
        { raw: null, received_at: T("05") },
        { raw: { vendorId: "v4", kind: "answer" }, received_at: T("05") },
      ],
    });
    expect(out).toEqual([]);
  });

  it("dedupes + sorts multiple countered vendors", () => {
    const out = deriveCountered({
      offers: [
        { vendor_id: "vb", round: 2, created_at: T("00") },
        { vendor_id: "va", round: 0, created_at: T("00") },
      ],
      replies: [{ vendor_id: "va", created_at: T("00") }],
      outbound: [
        { raw: { vendorId: "va", kind: "bargain" }, received_at: T("05") },
        { raw: { vendorId: "va", kind: "auto-bargain" }, received_at: T("06") },
      ],
    });
    expect(out).toEqual(["va", "vb"]);
  });
});
