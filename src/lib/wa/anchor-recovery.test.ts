import { describe, it, expect } from "vitest";
import { isUsableRfq, pickRecoveryRfq, RECOVERY_MAX_AGE_MS } from "./anchor-recovery";
import { numberVariants, threadNumberOr, waDigits, sameNumber } from "./phone-key";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const RFQ = { durationDays: 4, vehicleClass: "scooter", fulfillment: "any", accessories: [] };

describe("isUsableRfq", () => {
  it("accepts an RFQ with a real duration and a vehicle class", () => {
    expect(isUsableRfq(RFQ)).toBe(true);
  });

  it("rejects anything it would have to guess at", () => {
    expect(isUsableRfq(null)).toBe(false);
    expect(isUsableRfq({})).toBe(false);
    expect(isUsableRfq({ durationDays: 4 })).toBe(false); // no vehicle class
    expect(isUsableRfq({ vehicleClass: "scooter" })).toBe(false); // no duration
    expect(isUsableRfq({ durationDays: 0, vehicleClass: "scooter" })).toBe(false);
    expect(isUsableRfq({ durationDays: "4", vehicleClass: "scooter" })).toBe(false);
  });
});

describe("pickRecoveryRfq", () => {
  it("takes the NEWEST usable search", () => {
    const picked = pickRecoveryRfq(
      [
        { created_at: ago(60_000), rfq: { ...RFQ, durationDays: 2 } },
        { created_at: ago(600_000), rfq: { ...RFQ, durationDays: 9 } },
      ],
      NOW
    );
    expect(picked?.durationDays).toBe(2);
  });

  it("ignores searches older than the recovery window", () => {
    expect(
      pickRecoveryRfq([{ created_at: ago(RECOVERY_MAX_AGE_MS + 60_000), rfq: RFQ }], NOW)
    ).toBeNull();
  });

  it("skips unusable rows and falls back to an older usable one", () => {
    const picked = pickRecoveryRfq(
      [
        { created_at: ago(1000), rfq: { vehicleClass: "car" } }, // no duration
        { created_at: ago(5000), rfq: null },
        { created_at: ago(9000), rfq: RFQ },
      ],
      NOW
    );
    expect(picked?.durationDays).toBe(4);
  });

  it("is empty-safe and rejects future-dated rows (clock skew)", () => {
    expect(pickRecoveryRfq([], NOW)).toBeNull();
    expect(
      pickRecoveryRfq([{ created_at: new Date(NOW + 3600_000).toISOString(), rfq: RFQ }], NOW)
    ).toBeNull();
  });
});

// The bug class this whole file exists for: an outbound row written under one
// spelling of a number, an inbound reply arriving under another. If these ever
// diverge again, threads go silent with "no-rfq-thread".
describe("phone normalization is consistent across the inbound/outbound paths", () => {
  it("a Thai international inbound finds a nationally-stored outbound row", () => {
    const inbound = "66635236849"; // what Evolution delivers
    const variants = numberVariants(inbound);
    expect(variants).toContain("66635236849"); // international, as stored today
    expect(variants).toContain("0635236849"); // national with trunk 0 (Places)
    expect(variants).toContain("635236849"); // bare national
  });

  it("the or() filter matches every spelling and stays valid PostgREST", () => {
    const or = threadNumberOr("to_number", "66635236849");
    expect(or).toBe("(to_number.eq.66635236849,to_number.eq.635236849,to_number.eq.0635236849)");
  });

  it("device suffixes and JID hosts never create a second identity", () => {
    expect(waDigits("66635236849:12@s.whatsapp.net")).toBe("66635236849");
    expect(waDigits("+66 63 523 6849")).toBe("66635236849");
    expect(sameNumber("66635236849:3@s.whatsapp.net", "0635236849")).toBe(true);
  });

  it("two genuinely different shops never collide", () => {
    expect(sameNumber("66635236849", "66635816547")).toBe(false);
  });
});
