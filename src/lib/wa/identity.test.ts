import { describe, it, expect } from "vitest";
import { resolveOutreachIdentity } from "./identity";

describe("resolveOutreachIdentity (privacy keystone + orphaned-reply fix)", () => {
  it("keeps the real identity when there is NO reference phone to contradict it", () => {
    // The regression that orphaned every real reply: a legit shop with no
    // Google phone (Details 5xx/quota, unlisted, or a trusted seed vendor) was
    // being re-keyed to a test id, so its reply never bound back to the card.
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "", // unknown - NOT a contradiction
      supplied: "6281234567",
      ownerTestMode: false,
    });
    expect(d.action).toBe("keep");
  });

  it("keeps the real identity when the supplied number MATCHES the Google phone", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281234567",
      supplied: "6281234567",
      ownerTestMode: false,
    });
    expect(d.action).toBe("keep");
  });

  it("BUG 1B: an OWNER in production (no drill) keeps a real shop's real identity - no (unverified)", () => {
    // The owner is a normal user in production (TEST_MODE off). A real shop at
    // its real Google number must NOT be re-keyed to a "(unverified)" test id.
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281234567",
      supplied: "6281234567",
      ownerTestMode: false,
      vendorName: "Qui Motorbike Rental",
    });
    expect(d.action).toBe("keep");
  });

  it("BUG 1B: an OWNER in production keeps identity even with no reference phone", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "",
      supplied: "6281234567",
      ownerTestMode: false,
      vendorName: "Pai River Scooter",
    });
    expect(d.action).toBe("keep");
  });

  it("routes a NON-owner mismatch to the shop's own number (real shop wins)", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999", // spoofed / wrong number
      ownerTestMode: false,
    });
    expect(d).toEqual({ action: "send-to-shop", toPhone: "6281111111" });
  });

  it("re-keys an owner DRILL to a WINDOWED unverified identity even without a contradiction", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "",
      supplied: "6289999999",
      ownerTestMode: true,
      vendorName: "Bali Scooters",
    });
    expect(d.action).toBe("rekey-test");
    if (d.action === "rekey-test") {
      expect(d.vendorId).toBe("test-6289999999");
      expect(d.vendorName).toBe("Bali Scooters (unverified)");
    }
  });

  it("re-keys an owner DRILL mismatch to a test identity (owner cannot override to send elsewhere)", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      ownerTestMode: true,
    });
    expect(d.action).toBe("rekey-test");
  });

  it("never touches identity when the caller does not claim a real shop", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: false,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      ownerTestMode: false,
    });
    expect(d.action).toBe("keep");
  });

  it("keeps identity when there is no supplied number at all", () => {
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "",
      ownerTestMode: false,
    });
    expect(d.action).toBe("keep");
  });

  it("clamps an over-long vendor name to 56 chars before appending the marker", () => {
    const long = "X".repeat(200);
    const d = resolveOutreachIdentity({
      claimsRealShop: true,
      resolvedPhone: "6281111111",
      supplied: "6289999999",
      ownerTestMode: true,
      vendorName: long,
    });
    if (d.action === "rekey-test") {
      expect(d.vendorName).toBe(`${"X".repeat(56)} (unverified)`);
    } else {
      throw new Error("expected rekey-test");
    }
  });
});
