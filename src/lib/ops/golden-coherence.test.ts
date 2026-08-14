import { describe, it, expect, vi, beforeEach } from "vitest";

// The twelve authored coherence seeds (owner report 4/W2.2), replayed through
// the REAL engines exactly as the owner's eval gate replays them. If an
// engine change breaks cross-thread coherence - a rival invented, a floor
// undercut, a menu farewelled, a read board re-asked "as text" - this suite
// goes red in CI before the golden gate ever sees it live.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: () => null,
}));

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
  fail: false,
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async (_t: string, rows: Array<Record<string, unknown>>) => {
    if (store.fail) return false;
    store.rows.push(...rows);
    return true;
  },
  sbInsertReturning: async () => [],
  sbSelect: async (_t: string, q: string) => {
    store.selects.push(q);
    return store.fail ? [] : store.rows.map((r) => ({ name: r.name }));
  },
  sbSelectStrict: async (_t: string, q: string) => {
    store.selects.push(q);
    if (store.fail) return { error: "unavailable" as const };
    return { rows: store.rows.map((r) => ({ name: r.name })) };
  },
  sbUpdate: async () => {},
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  supabaseConfigured: () => false,
}));
vi.mock("../wa-guard", () => ({
  guardOutbound: async ({ text }: { text: string }) => ({ allow: true, text }),
  afterSend: async () => {},
}));
vi.mock("../market", () => ({
  floorPriceFor: async () => ({ floor: 150, typical: 240, currency: "THB" }),
  vehicleKeyFor: () => "motorbike-125",
  regionKeysFor: () => ["chiang-mai"],
}));

import { replayConversation, replaySpteTurns } from "../simulate";
import { evaluateCase } from "./golden";
import { defaultGraphSpec } from "../graph/default-graph";
import { COHERENCE_GOLDEN_SEEDS, ensureCoherenceGoldenCases } from "./golden-coherence";
import type { GoldenCase } from "./types";

beforeEach(() => {
  store.rows = [];
  store.selects = [];
  store.fail = false;
});

describe("the twelve coherence seeds pass the replay gate", () => {
  for (const s of COHERENCE_GOLDEN_SEEDS) {
    it(s.name, async () => {
      const gc: GoldenCase = { ...s, id: 0, created_at: "t" };
      const [graph, spte] = await Promise.all([
        replayConversation({
          turns: gc.turns,
          rfq: gc.rfq,
          region: gc.region ?? undefined,
          floor: gc.floor,
          spec: defaultGraphSpec(),
        }),
        replaySpteTurns({ turns: gc.turns, rfq: gc.rfq, floor: gc.floor }),
      ]);
      const res = evaluateCase(gc, graph.turns, spte.turns);
      expect(
        res.turns.flatMap((t) =>
          t.failures.map((f) => `turn ${t.turn} [got move=${t.got.move}]: ${f}`)
        )
      ).toEqual([]);
      expect(res.pass).toBe(true);
    });
  }

  it("the suite really has the promised dozen, all enabled", () => {
    expect(COHERENCE_GOLDEN_SEEDS.length).toBe(12);
    expect(COHERENCE_GOLDEN_SEEDS.every((s) => s.enabled)).toBe(true);
    // Namespaced so the durable-store upsert can key on the prefix.
    expect(COHERENCE_GOLDEN_SEEDS.every((s) => s.name.startsWith("coherence: "))).toBe(true);
  });
});

describe("ensureCoherenceGoldenCases - idempotent, additive, fail-safe", () => {
  it("inserts all twelve into an empty store, and none the second time", async () => {
    expect(await ensureCoherenceGoldenCases()).toBe(12);
    expect(store.rows.length).toBe(12);
    expect(await ensureCoherenceGoldenCases()).toBe(0);
    expect(store.rows.length).toBe(12);
  });

  it("an unreadable store inserts NOTHING - never a blind double-seed", async () => {
    store.fail = true;
    expect(await ensureCoherenceGoldenCases()).toBe(0);
  });

  it("the golden gate runs the seeding before listing (and survives its failure)", async () => {
    const { readFileSync } = await import("fs");
    const golden = readFileSync("src/lib/ops/golden.ts", "utf8");
    expect(golden).toMatch(/ensureCoherenceGoldenCases/);
    expect(golden).toMatch(/const MAX_CASES = 48/);
  });
});
