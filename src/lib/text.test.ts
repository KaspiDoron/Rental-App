import { describe, it, expect } from "vitest";
import { stripWaFormatting, sanitizeAiText } from "./text";

describe("stripWaFormatting - the shop never sees markdown/`*` artifacts", () => {
  it("kills the exact reported artifacts (leading/standalone asterisk)", () => {
    expect(stripWaFormatting("good *good day!")).toBe("good good day!");
    expect(stripWaFormatting("hi, qiuck *quick question - could I rent?")).toBe(
      "hi, qiuck quick question - could I rent?"
    );
  });

  it("strips **bold** and inline code", () => {
    expect(stripWaFormatting("**best** price here")).toBe("best price here");
    expect(stripWaFormatting("use `code` here")).toBe("use code here");
  });

  it("removes trailing/stray asterisks and backticks", () => {
    expect(stripWaFormatting("price*")).toBe("price");
    expect(stripWaFormatting("a ` b")).toBe("a b");
  });

  it("PRESERVES underscores in URLs / emails / identifiers (no link corruption)", () => {
    expect(stripWaFormatting("see https://maps.example.com/rent_a_bike now")).toBe(
      "see https://maps.example.com/rent_a_bike now"
    );
    expect(stripWaFormatting("mail john_q_public@site.com")).toBe("mail john_q_public@site.com");
  });

  it("leaves clean human text untouched (incl. emoji)", () => {
    expect(stripWaFormatting("any cheaper? 🙏")).toBe("any cheaper? 🙏");
    expect(stripWaFormatting("can you do 250 a day?")).toBe("can you do 250 a day?");
  });

  it("collapses the doubled spaces the removals leave", () => {
    expect(stripWaFormatting("hi  there")).toBe("hi there");
  });

  it("sanitizeAiText alone leaves an UNPAIRED leading asterisk (why stripWaFormatting exists)", () => {
    // Guards the regression: the old sanitizer did not catch "*good".
    expect(sanitizeAiText("good *good day")).toContain("*good");
  });
});
