import { describe, it, expect } from "vitest";
import { stripWaFormatting, sanitizeAiText } from "./text";

describe("stripWaFormatting - the shop never sees markdown/`*` artifacts", () => {
  it("kills the exact reported artifacts (leading/standalone asterisk)", () => {
    expect(stripWaFormatting("good *good day!")).toBe("good good day!");
    expect(stripWaFormatting("hi, qiuck *quick question - could I rent?")).toBe(
      "hi, qiuck quick question - could I rent?"
    );
  });

  it("strips paired markdown too (via sanitizeAiText)", () => {
    expect(stripWaFormatting("**best** price and _today_ only")).toBe("best price and today only");
    expect(stripWaFormatting("use `code` here")).toBe("use code here");
  });

  it("removes trailing and mid stray asterisks/backticks", () => {
    expect(stripWaFormatting("price*")).toBe("price");
    expect(stripWaFormatting("a ` b")).toBe("a b");
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
