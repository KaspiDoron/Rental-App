import { describe, it, expect } from "vitest";
import { boundedSet } from "./bounded-map";

describe("boundedSet", () => {
  it("keeps the map at or under the cap", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 50; i++) boundedSet(m, `k${i}`, i, 10);
    expect(m.size).toBe(10);
  });

  it("evicts oldest-first, so the newest survive", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) boundedSet(m, `k${i}`, i, 3);
    expect([...m.keys()]).toEqual(["k2", "k3", "k4"]);
  });

  it("re-inserting a key refreshes it (approximate LRU, not FIFO-by-creation)", () => {
    const m = new Map<string, number>();
    boundedSet(m, "a", 1, 3);
    boundedSet(m, "b", 2, 3);
    boundedSet(m, "c", 3, 3);
    // Touch "a" so it is newest, then overflow by one.
    boundedSet(m, "a", 9, 3);
    boundedSet(m, "d", 4, 3);
    // "b" was the coldest, so it goes - NOT "a", which was created first.
    expect(m.has("a")).toBe(true);
    expect(m.get("a")).toBe(9);
    expect(m.has("b")).toBe(false);
    expect(m.size).toBe(3);
  });

  it("does not evict while under the cap", () => {
    const m = new Map<string, number>();
    boundedSet(m, "a", 1, 5);
    boundedSet(m, "b", 2, 5);
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(1);
  });
});
