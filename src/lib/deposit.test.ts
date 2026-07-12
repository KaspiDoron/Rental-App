import { describe, it, expect } from "vitest";
import { parseDeposit } from "./deposit";

describe("parseDeposit", () => {
  it("returns null when nothing was stated", () => {
    expect(parseDeposit("")).toBeNull();
    expect(parseDeposit(null)).toBeNull();
    expect(parseDeposit("   ")).toBeNull();
  });

  it("parses a cash amount with an explicit currency", () => {
    expect(parseDeposit("3,000 THB cash")).toEqual({ type: "cash", amount: 3000, currency: "THB" });
  });

  it("parses a bare cash amount using the fallback currency", () => {
    expect(parseDeposit("5000", "IDR")).toEqual({ type: "cash", amount: 5000, currency: "IDR" });
  });

  it("recognises a currency word (baht) not just the ISO code", () => {
    expect(parseDeposit("2000 baht")).toEqual({ type: "cash", amount: 2000, currency: "THB" });
  });

  it("parses a passport-only requirement", () => {
    expect(parseDeposit("Passport only")).toEqual({ type: "passport" });
  });

  it("keeps the cash figure when passport OR cash is offered", () => {
    expect(parseDeposit("Passport or 2000 baht")).toEqual({
      type: "passport",
      amount: 2000,
      currency: "THB",
    });
  });

  it("detects an explicit no-deposit", () => {
    expect(parseDeposit("No deposit")).toEqual({ type: "none" });
    expect(parseDeposit("deposit-free")).toEqual({ type: "none" });
  });

  it("handles dotted thousands separators", () => {
    expect(parseDeposit("3.000 IDR")).toEqual({ type: "cash", amount: 3000, currency: "IDR" });
  });

  it("falls back to 'other' for an unrecognised non-cash label", () => {
    expect(parseDeposit("credit card imprint")).toEqual({ type: "other" });
  });
});
