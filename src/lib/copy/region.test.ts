import { describe, it, expect } from "vitest";
import { regionFromPhone, regionForShop } from "./region";

describe("regionFromPhone - country prefix wins", () => {
  it("maps SE-Asia prefixes", () => {
    expect(regionFromPhone("+84 37 598 5795")).toBe("vietnam");
    expect(regionFromPhone("6391234567")).toBe("philippines");
    expect(regionFromPhone("+66 81 234 5678")).toBe("thailand");
    expect(regionFromPhone("62812345678")).toBe("indonesia");
  });
  it("strips leading zeros / non-digits and returns null outside the markets", () => {
    expect(regionFromPhone("0084375985795")).toBe("vietnam"); // leading 0 stripped
    expect(regionFromPhone("+1 415 555 0000")).toBeNull(); // US
    expect(regionFromPhone("")).toBeNull();
  });
});

describe("regionForShop - phone beats label", () => {
  it("a +84 shop is vietnam even when the label names another country", () => {
    expect(regionForShop("+84375985795", "Cebu, Philippines")).toBe("vietnam");
  });
  it("falls back to the label country when the phone is non-SEA", () => {
    expect(regionForShop("+1 415 555 0000", "Muong Thanh Hotel, Vietnam")).toBe("vietnam");
  });
  it("undefined when neither resolves", () => {
    expect(regionForShop("+1 415 555 0000", "Reykjavik, Iceland")).toBeUndefined();
  });
});
