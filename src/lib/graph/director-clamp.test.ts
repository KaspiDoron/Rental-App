import { describe, it, expect, vi } from "vitest";

// B7 REGRESSION: the director's `silent` verdict was the ONE unclamped LLM
// output. A first-turn decline/redirect ("I am a bicycle rental - try MASCO")
// owes exactly ONE warm goodbye (a non-silent close edge, higher priority)
// before the silent edge. An unclamped `silent` skipped that goodbye and froze
// the thread forever. The clamp: honor `silent` only when a silent edge is
// itself the TOP legal move; otherwise the deterministic ladder wins.

vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  // The director LLM insists on silence regardless of what's legal.
  chat: async () => JSON.stringify({ action: "silent", reasoning: "shop walked away" }),
  chatDetailed: async () => ({ text: null }),
  chatVision: async () => null,
  extractJson: (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  },
}));
vi.mock("../runtime-config", () => ({
  getConfig: async () => undefined,
  setConfig: async () => {},
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbUpdate: async () => {},
}));
vi.mock("../ops/learning", () => ({
  getOpsLearning: async () => null,
  formatDirectorLearning: () => "",
}));

import { runDirector } from "./director";
import type { LegalEdge } from "./types";

const baseArgs = {
  input: {
    event: { kind: "shop-message", shopMessage: "I am a bicycle rental - try MASCO" },
    history: "",
    floorPrice: 0,
  },
  state: { fields: { rounds: 0, firmCount: 0 } },
  facts: { event: "shop-message" },
  session: [],
  settings: {
    maxRoundsPerShop: 5,
    strategicWaitMaxMin: 30,
    waitWindow: { minS: 60, maxS: 600 },
  },
  instructions: "",
  llmAllowed: true,
} as any;

describe("B7 director silent clamp", () => {
  it("coerces a bare 'silent' to the top NON-silent legal edge (the mandatory goodbye)", async () => {
    // Ladder as the default graph builds it on a first decline: a close edge
    // (higher priority) then the silent edge.
    const legal: LegalEdge[] = [
      { edgeId: "d-declined-close", label: "one warm goodbye", toKind: "close" } as any,
      { edgeId: "d-declined-silent", label: "silence", toKind: "silent" } as any,
    ];
    const choice = await runDirector({ ...baseArgs, legal });
    expect(choice.action).toBe("act");
    expect(choice.edgeId).toBe("d-declined-close");
  });

  it("honors 'silent' only when the silent edge is itself the top legal move", async () => {
    const legal: LegalEdge[] = [
      { edgeId: "d-silent-closed", label: "session closed", toKind: "silent" } as any,
    ];
    const choice = await runDirector({ ...baseArgs, legal });
    expect(choice.action).toBe("silent");
  });
});
