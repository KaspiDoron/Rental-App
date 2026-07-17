import { describe, it, expect } from "vitest";
import { enforceEmojiTone, trigramOverlap } from "./uniqueness";

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu;
const count = (s: string) => (s.match(EMOJI) ?? []).length;

describe("enforceEmojiTone - exactly one warm emoji", () => {
  it("adds one when the message has none", () => {
    const out = enforceEmojiTone("Can you do 200 a day for 5 days?", true);
    expect(count(out)).toBe(1);
  });

  it("keeps a single existing emoji untouched", () => {
    const out = enforceEmojiTone("Thanks so much 🙏", true);
    expect(count(out)).toBe(1);
    expect(out).toContain("🙏");
  });

  it("trims a stacked emoji chain down to exactly one (the policy, not two)", () => {
    expect(count(enforceEmojiTone("Great deal 🙂🙏🤝", true))).toBe(1);
    expect(count(enforceEmojiTone("Yes!! 😊😊 please 🙏", true))).toBe(1);
  });

  it("is a no-op when disabled", () => {
    const s = "no tone here 🙂🙂🙂";
    expect(enforceEmojiTone(s, false)).toBe(s);
  });
});

describe("trigramOverlap sanity (unchanged)", () => {
  it("scores identical text as full overlap", () => {
    expect(trigramOverlap("hello there my friend", "hello there my friend")).toBeGreaterThan(0.9);
  });
});
