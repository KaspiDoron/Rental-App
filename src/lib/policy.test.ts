import { describe, it, expect, vi } from "vitest";

// policy.ts is server-only and touches Supabase + the graph engine; stub the
// heavy edges so the clamp/versioning logic is tested pure.
vi.mock("server-only", () => ({}));
vi.mock("./runtime-config", () => ({
  sbSelect: vi.fn(async () => []),
  sbInsertReturning: vi.fn(async () => []),
  sbUpdate: vi.fn(async () => false),
  setConfig: vi.fn(async () => {}),
  getConfig: vi.fn(async () => null),
}));
vi.mock("./graph/engine", () => ({
  saveGraphSpec: vi.fn(async () => ({ ok: true, problems: [] })),
}));

import { clampOverlay, DEFAULT_OVERLAY } from "./policy";

describe("policy overlay clamps", () => {
  it("returns pure defaults for empty/garbage input", () => {
    expect(clampOverlay(null)).toEqual({ ...DEFAULT_OVERLAY, bannedPhrases: [] });
    expect(clampOverlay("nonsense")).toEqual({ ...DEFAULT_OVERLAY, bannedPhrases: [] });
    expect(clampOverlay({ floorTolerance: "abc" }).floorTolerance).toBe(
      DEFAULT_OVERLAY.floorTolerance
    );
  });

  it("defaults match the engine's historical literals exactly", () => {
    // These MUST stay in lockstep with the hardcoded math they replace -
    // "no overlay saved" must mean byte-identical negotiation behavior.
    expect(DEFAULT_OVERLAY.floorTolerance).toBe(1.05);
    expect(DEFAULT_OVERLAY.priceFarAboveFloor).toBe(1.08);
    expect(DEFAULT_OVERLAY.sheetAnchor).toBe(0.8);
    expect(DEFAULT_OVERLAY.lowballGuard).toBe(0.6);
    expect(DEFAULT_OVERLAY.defaultCut).toBe(0.85);
  });

  it("clamps every numeric field into its hard range", () => {
    const wild = clampOverlay({
      floorTolerance: 99,
      priceFarAboveFloor: 0,
      sheetAnchor: 2,
      lowballGuard: -1,
      defaultCut: 0.1,
    });
    expect(wild.floorTolerance).toBe(1.15);
    expect(wild.priceFarAboveFloor).toBe(1.03);
    expect(wild.sheetAnchor).toBe(0.95);
    expect(wild.lowballGuard).toBe(0.5);
    expect(wild.defaultCut).toBe(0.7);
  });

  it("keeps legal in-range values untouched", () => {
    const ok = clampOverlay({ defaultCut: 0.8, sheetAnchor: 0.85 });
    expect(ok.defaultCut).toBe(0.8);
    expect(ok.sheetAnchor).toBe(0.85);
  });

  it("sanitizes banned phrases: strings only, trimmed, capped at 20", () => {
    const out = clampOverlay({
      bannedPhrases: ["  final offer  ", "", 42, ...Array(30).fill("x")],
    });
    expect(out.bannedPhrases[0]).toBe("final offer");
    expect(out.bannedPhrases).not.toContain("");
    expect(out.bannedPhrases.length).toBeLessThanOrEqual(20);
  });
});
