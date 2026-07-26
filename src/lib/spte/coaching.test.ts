import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Records every PostgREST query the coaching loader makes, so we can assert
// WHICH lessons it asked for - the whole point of situational retrieval.
const queries: Array<{ table: string; q: string }> = [];
const rows: Record<string, Array<{ text: string }>> = {};

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, q: string) => {
    queries.push({ table, q });
    for (const [needle, value] of Object.entries(rows)) {
      if (q.includes(needle)) return value;
    }
    return [];
  },
}));
vi.mock("../ops/learning", () => ({ getOpsLearning: async () => null }));

import { bustCoachingCache, loadCoaching } from "./coaching";

beforeEach(() => {
  queries.length = 0;
  for (const k of Object.keys(rows)) delete rows[k];
  bustCoachingCache();
});

describe("situational lesson retrieval", () => {
  it("asks ONLY for the lessons that match this turn", async () => {
    await loadCoaching(["option-menu"]);
    const lessonQ = queries.find((x) => x.q.includes("source=eq.ops-lesson"));
    expect(lessonQ).toBeTruthy();
    expect(lessonQ!.q).toContain('"lesson:option-menu"');
    // A photo lesson has no business on a turn with no photo in it.
    expect(lessonQ!.q).not.toContain("photo-price-board");
  });

  it("skips the lesson query entirely when nothing situational applies", async () => {
    await loadCoaching([]);
    expect(queries.some((x) => x.q.includes("source=eq.ops-lesson"))).toBe(false);
  });

  it("dedupes and orders the situation so two callers share one cache entry", async () => {
    rows["source=eq.ops-lesson"] = [{ text: "LESSON A" }];
    const a = await loadCoaching(["photo-price-board", "option-menu", "option-menu"]);
    const before = queries.length;
    const b = await loadCoaching(["option-menu", "photo-price-board"]);
    expect(b).toBe(a);
    expect(queries.length).toBe(before); // served from cache, no new queries
  });

  it("a DIFFERENT situation is a different cache entry, not a stale hit", async () => {
    rows["source=eq.ops-lesson"] = [{ text: "LESSON A" }];
    await loadCoaching(["option-menu"]);
    const before = queries.length;
    await loadCoaching(["decline"]);
    expect(queries.length).toBeGreaterThan(before);
  });

  it("states lessons as RULES, above the tone-only style block", async () => {
    rows["source=eq.ops-lesson"] = [{ text: "[LESSON] that was a menu - resolve it first" }];
    rows["source=eq.distilled"] = [{ text: "friendly opener example" }];
    const text = await loadCoaching(["option-menu"]);
    expect(text).toContain("WHAT THE OWNER TAUGHT US");
    expect(text).toContain("resolve it first");
    // The tone framing must not swallow the rule - order matters.
    expect(text.indexOf("WHAT THE OWNER TAUGHT US")).toBeLessThan(
      text.indexOf("LEARNED STYLE")
    );
  });

  it("stays inside the prompt budget", async () => {
    rows["source=eq.ops-lesson"] = [
      { text: "L".repeat(2000) },
      { text: "M".repeat(2000) },
      { text: "N".repeat(2000) },
    ];
    const text = await loadCoaching(["option-menu"]);
    expect(text.length).toBeLessThanOrEqual(1400);
  });

  it("a read failure yields no coaching, never a broken turn", async () => {
    // sbSelect returns [] for everything here, so nothing is injected.
    expect(await loadCoaching(["option-menu"])).toBe("");
  });
});
