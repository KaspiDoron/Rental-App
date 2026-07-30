import { describe, it, expect } from "vitest";
import { pickSweepEmails, rotateWindow } from "./sweep";

describe("pickSweepEmails - fair minute-rotated coverage", () => {
  const emails = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];

  it("returns all when the pool fits in n", () => {
    expect(pickSweepEmails(["a", "b"], 0, 3).sort()).toEqual(["a", "b"]);
  });

  it("picks a rotating window of size n", () => {
    expect(pickSweepEmails(emails, 0, 2)).toEqual(["a@x.com", "b@x.com"]);
    expect(pickSweepEmails(emails, 1, 2)).toEqual(["b@x.com", "c@x.com"]);
    expect(pickSweepEmails(emails, 4, 2)).toEqual(["e@x.com", "a@x.com"]); // wraps
  });

  it("covers every sender across a full rotation", () => {
    const seen = new Set<string>();
    for (let m = 0; m < emails.length; m++) pickSweepEmails(emails, m, 2).forEach((e) => seen.add(e));
    expect([...seen].sort()).toEqual([...emails].sort());
  });

  it("dedupes, sorts, and tolerates empties / bad n", () => {
    expect(pickSweepEmails(["b", "a", "a", ""], 0, 2)).toEqual(["a", "b"]);
    expect(pickSweepEmails([], 3, 2)).toEqual([]);
    expect(pickSweepEmails(emails, 3, 0)).toEqual([]);
  });

  it("is deterministic for a fixed minute", () => {
    expect(pickSweepEmails(emails, 7, 3)).toEqual(pickSweepEmails(emails, 7, 3));
  });
});

describe("rotateWindow - the per-thread sweep visits EVERY open thread", () => {
  const items = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"];

  it("returns everything when the list fits the window", () => {
    expect(rotateWindow(items.slice(0, 3), 99, 5)).toEqual(["n1", "n2", "n3"]);
  });

  it("advances a FULL window per tick (not one item), so coverage is fast", () => {
    expect(rotateWindow(items, 0, 5)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(rotateWindow(items, 1, 5)).toEqual(["n6", "n7", "n1", "n2", "n3"]);
  });

  it("covers a 40-shop ultra batch completely across consecutive ticks", () => {
    const batch = Array.from({ length: 40 }, (_, i) => `shop${i}`);
    const seen = new Set<string>();
    for (let t = 0; t < 8; t++) rotateWindow(batch, t, 5).forEach((s) => seen.add(s));
    expect(seen.size).toBe(40);
  });

  it("tolerates negative ticks and bad sizes", () => {
    expect(rotateWindow(items, -3, 5)).toHaveLength(5);
    expect(rotateWindow(items, 2, 0)).toEqual([]);
  });
});
