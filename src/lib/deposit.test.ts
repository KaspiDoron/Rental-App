import { describe, it, expect } from "vitest";
import { parseDeposit } from "./deposit";

// The legacy fields are asserted with `toMatchObject` rather than `toEqual`,
// because a deposit now also carries its full `options` structure. The flat
// fields are the back-compat view every stored offer and filter still reads,
// so they are pinned exactly as before; the structure is pinned separately.

describe("parseDeposit - the flat, legacy view", () => {
  it("returns null when nothing was stated", () => {
    expect(parseDeposit("")).toBeNull();
    expect(parseDeposit(null)).toBeNull();
    expect(parseDeposit("   ")).toBeNull();
  });

  it("parses a cash amount with an explicit currency", () => {
    expect(parseDeposit("3,000 THB cash")).toMatchObject({
      type: "cash",
      amount: 3000,
      currency: "THB",
    });
  });

  it("parses a bare cash amount using the fallback currency", () => {
    expect(parseDeposit("5000", "IDR")).toMatchObject({
      type: "cash",
      amount: 5000,
      currency: "IDR",
    });
  });

  it("recognises a currency word (baht) not just the ISO code", () => {
    expect(parseDeposit("2000 baht")).toMatchObject({
      type: "cash",
      amount: 2000,
      currency: "THB",
    });
  });

  it("parses a passport-only requirement", () => {
    expect(parseDeposit("Passport only")).toMatchObject({ type: "passport" });
  });

  it("keeps the cash figure when passport OR cash is offered", () => {
    expect(parseDeposit("Passport or 2000 baht")).toMatchObject({
      type: "passport",
      amount: 2000,
      currency: "THB",
    });
  });

  it("detects an explicit no-deposit", () => {
    expect(parseDeposit("No deposit")).toMatchObject({ type: "none", options: [] });
    expect(parseDeposit("deposit-free")).toMatchObject({ type: "none", options: [] });
  });

  it("handles dotted thousands separators", () => {
    expect(parseDeposit("3.000 IDR")).toMatchObject({
      type: "cash",
      amount: 3000,
      currency: "IDR",
    });
  });

  it("falls back to 'other' for an unrecognised non-cash label", () => {
    expect(parseDeposit("credit card imprint")).toMatchObject({ type: "other" });
  });
});

describe("a deposit is a SET OF ALTERNATIVES, each a BUNDLE", () => {
  // The live shop line that exposed the whole gap. Flattened to one enum it
  // rendered as "Passport or ฿2" - wrong document, wrong conjunction, and an
  // amount taken from "(2 Options)".
  const INCIDENT =
    "Deposits for motorbikes (2 Options) 1) Or Original Passport 2) Or Copy Passport + 3000 THB";

  it("reads the incident line as two real options", () => {
    const d = parseDeposit(INCIDENT, "THB")!;
    expect(d.options).toEqual([
      { parts: [{ kind: "passport_original" }] },
      { parts: [{ kind: "passport_copy" }, { kind: "cash", amount: 3000, currency: "THB" }] },
    ]);
  });

  it("never mistakes a counting number for money", () => {
    // "(2 Options)" was parsed as a 2-baht deposit by the first-number rule.
    expect(parseDeposit(INCIDENT, "THB")!.amount).toBe(3000);
    expect(parseDeposit("2 options: passport or 3000 baht", "THB")!.amount).toBe(3000);
  });

  it("keeps ORIGINAL passport and a COPY apart - they are different asks", () => {
    expect(parseDeposit("original passport")!.options[0].parts[0].kind).toBe("passport_original");
    expect(parseDeposit("copy of passport")!.options[0].parts[0].kind).toBe("passport_copy");
    expect(parseDeposit("passport photocopy")!.options[0].parts[0].kind).toBe("passport_copy");
  });

  it("distinguishes OR (alternatives) from + (a bundle)", () => {
    const either = parseDeposit("passport or 2000 baht", "THB")!;
    expect(either.options).toHaveLength(2);

    const both = parseDeposit("passport copy + 2000 baht", "THB")!;
    expect(both.options).toHaveLength(1);
    expect(both.options[0].parts).toHaveLength(2);
  });

  it("the legacy amount is the CHEAPEST cash option, so filters stay honest", () => {
    // A filter comparing against the first-written option would hide a shop
    // whose other option is affordable.
    const d = parseDeposit("5000 baht or copy passport + 1000 baht", "THB")!;
    expect(d.amount).toBe(1000);
  });

  it("a numbered list wins over an 'or' that appears inside one option", () => {
    const d = parseDeposit(INCIDENT, "THB")!;
    expect(d.options).toHaveLength(2);
  });
});
