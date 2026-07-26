import { describe, it, expect } from "vitest";
import { similarity, isRepetitive } from "./similarity";

describe("similarity - the live repeated-bargain shape", () => {
  const a = "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 330 PHP/day?";
  const b = "thanks for the offer! Since I'm booking for 4 days, can u give me an even better deal, like 320 PHP/day?";
  const c = "thanks for the offer! Since I'm booking for 4 days, can you give me an even better deal, like 280 PHP/day?";

  it("flags the near-identical bargains (only the price changed)", () => {
    expect(similarity(a, b)).toBeGreaterThan(0.75);
    expect(isRepetitive(c, [a, b])).toBe(true);
  });

  it("passes a genuinely different lever", () => {
    const fresh = "Appreciate it! Could you throw in a free helmet and delivery if I book right now?";
    expect(similarity(a, fresh)).toBeLessThan(0.5);
    expect(isRepetitive(fresh, [a, b, c])).toBe(false);
  });

  it("is empty-safe", () => {
    expect(similarity("", "hello")).toBe(0);
    expect(isRepetitive("hi", [])).toBe(false);
  });
});
