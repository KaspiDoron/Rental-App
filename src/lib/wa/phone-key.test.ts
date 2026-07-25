import { describe, it, expect } from "vitest";
import { waDigits, numberVariants, threadNumberOr, sameNumber } from "./phone-key";
import { article } from "../copy/matrix";

describe("waDigits", () => {
  it("strips the JID host and the multi-device suffix", () => {
    // The exact shape that broke thread lookup: a device-suffixed JID kept
    // ":12", producing a key no outbound anchor could match.
    expect(waDigits("639661952196:12@s.whatsapp.net")).toBe("639661952196");
    expect(waDigits("639661952196@s.whatsapp.net")).toBe("639661952196");
    expect(waDigits("639661952196@c.us")).toBe("639661952196");
    expect(waDigits("+63 966 195 2196")).toBe("639661952196");
    expect(waDigits("")).toBe("");
    expect(waDigits(null)).toBe("");
  });
});

describe("numberVariants", () => {
  it("bridges international and national PH spellings", () => {
    // Google Places may only expose "0966 195 2196" while WhatsApp delivers
    // "639661952196" - the two must resolve to each other.
    const intl = numberVariants("639661952196");
    expect(intl).toContain("639661952196");
    expect(intl).toContain("09661952196");
    expect(intl).toContain("9661952196");
  });

  it("expands a national number back to international when the code is known", () => {
    const nat = numberVariants("09661952196", "63");
    expect(nat).toContain("09661952196");
    expect(nat).toContain("639661952196");
  });

  it("is empty for junk", () => {
    expect(numberVariants("")).toEqual([]);
    expect(numberVariants(null)).toEqual([]);
  });
});

describe("threadNumberOr", () => {
  it("builds a PostgREST or() over every spelling", () => {
    const or = threadNumberOr("to_number", "639661952196");
    expect(or).toMatch(/^\(/);
    expect(or).toContain("to_number.eq.639661952196");
    expect(or).toContain("to_number.eq.09661952196");
  });
  it("returns null when there is nothing to match", () => {
    expect(threadNumberOr("to_number", "")).toBeNull();
  });
});

describe("sameNumber", () => {
  it("matches across spellings, rejects different shops", () => {
    expect(sameNumber("639661952196", "09661952196")).toBe(true);
    expect(sameNumber("639661952196@s.whatsapp.net", "+63 966 195 2196")).toBe(true);
    expect(sameNumber("639661952196", "639166569405")).toBe(false);
    expect(sameNumber("", "639661952196")).toBe(false);
  });
});

describe("article (opener grammar)", () => {
  it("uses 'an' before a vowel sound - the live 'a automatic scooter' bug", () => {
    expect(article("automatic scooter")).toBe("an");
    expect(article("automatic scooter (125cc)")).toBe("an");
  });
  it("uses 'a' before consonants and most digits", () => {
    expect(article("manual motorbike")).toBe("a");
    expect(article("125cc scooter")).toBe("a");
    expect(article("car")).toBe("a");
  });
  it("handles digit-initial words that are read with a vowel sound", () => {
    expect(article("11-seater van")).toBe("an");
    expect(article("8-seater van")).toBe("an");
  });
  it("is empty-safe", () => {
    expect(article("")).toBe("a");
  });
});
