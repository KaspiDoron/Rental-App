import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeDigits, significantNumbers, numbersPreserved } from "./translation";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("local digit scripts are not a translation failure", () => {
  it("folds the scripts this app actually meets", () => {
    expect(normalizeDigits("๑๘๐ บาท")).toBe("180 บาท");
    expect(normalizeDigits("١٨٠")).toBe("180");
    expect(normalizeDigits("१८०")).toBe("180");
    expect(normalizeDigits("１８０")).toBe("180");
    // Everything that is not a digit is untouched.
    expect(normalizeDigits("180 baht")).toBe("180 baht");
  });

  it("a Thai translation that keeps the price in Thai numerals PASSES", () => {
    expect(numbersPreserved("180 baht per day", "วันละ ๑๘๐ บาท")).toBe(true);
  });
});

describe("only load-bearing numbers are enforced", () => {
  it("prices count", () => {
    expect(significantNumbers("180 baht for 3 days")).toEqual(["180"]);
  });

  it("small counts do NOT - 'three days' is idiomatic and must not flip us to English", () => {
    expect(numbersPreserved("can I have it for 3 days?", "ขอ 3 วันได้ไหม")).toBe(true);
    expect(numbersPreserved("can I have it for 3 days?", "ขอสามวันได้ไหม")).toBe(true);
  });

  it("thousand separators are normalised, not treated as different numbers", () => {
    expect(numbersPreserved("1,200 baht", "1200 บาท")).toBe(true);
    expect(numbersPreserved("1200 baht", "1.200 บาท")).toBe(true);
    // ...but a decimal is still its own number, not a separator.
    expect(significantNumbers("3.5 litres and 250 baht")).toEqual(["250"]);
  });
});

describe("REPRODUCTION: a price that does not survive the trip is caught", () => {
  it("a dropped price fails", () => {
    expect(numbersPreserved("180 baht per day", "วันละเท่าไหร่ครับ")).toBe(false);
  });

  it("a DRIFTED price fails - this is the one that sends a wrong offer", () => {
    expect(numbersPreserved("180 baht per day", "วันละ 150 บาท")).toBe(false);
  });

  it("a message with no significant numbers is always fine", () => {
    expect(numbersPreserved("hey, is the scooter available tomorrow?", "สวัสดีครับ")).toBe(true);
  });
});

describe("localizeMessage actually uses it", () => {
  const agents = readCode("src/lib/agents.ts");

  it("the check runs on the produced text and retries rather than sending", () => {
    expect(agents).toMatch(/if \(!numbersPreserved\(source, text\)\) \{/);
    expect(agents).toMatch(/continue;/);
  });

  it("REPRODUCTION: the English rail now runs on the translate path too", () => {
    // personaHumanize (which carries deAmbiguateFree) is deliberately skipped
    // for local-language output, so the ambiguity travelled into Thai intact.
    expect(agents).toMatch(/const source = deAmbiguateFree\(message\);/);
    // ...and every return uses the corrected source, not the raw message.
    expect(agents).not.toMatch(/return \{ text: message, localized: false \}/);
  });
});
