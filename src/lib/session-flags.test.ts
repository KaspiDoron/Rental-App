import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the (server-only) runtime-config so the pure tri-state logic is testable.
const mockStrict = vi.fn();
vi.mock("./runtime-config", () => ({
  sbInsert: vi.fn(async () => true),
  sbSelectStrict: (...args: unknown[]) => mockStrict(...args),
}));

import { isThreadTakenOver, isSessionPaused } from "./session-flags";

describe("takeover/pause vetoes are TRI-STATE and fail closed on an unreadable store", () => {
  beforeEach(() => {
    mockStrict.mockReset();
    // Clear the module caches so each case reads fresh.
    (globalThis as { __wd_takeover_flags__?: unknown }).__wd_takeover_flags__ = undefined;
    (globalThis as { __wd_session_flags__?: unknown }).__wd_session_flags__ = undefined;
  });

  it("returns null when the store is UNAVAILABLE (the fix: never a false 'not taken over')", async () => {
    mockStrict.mockResolvedValue({ error: "unavailable" });
    expect(await isThreadTakenOver("a@x.com", "111")).toBe(null);
    expect(await isSessionPaused("a@x.com")).toBe(null);
  });

  it("returns false when the marker table is MISSING (demo / un-migrated - genuinely no marker)", async () => {
    mockStrict.mockResolvedValue({ error: "missing" });
    expect(await isThreadTakenOver("b@x.com", "111")).toBe(false);
    expect(await isSessionPaused("b@x.com")).toBe(false);
  });

  it("returns true when the latest marker is takeover / paused", async () => {
    mockStrict.mockResolvedValue({ rows: [{ raw: { kind: "human-takeover" } }] });
    expect(await isThreadTakenOver("c@x.com", "111")).toBe(true);
    mockStrict.mockResolvedValue({ rows: [{ raw: { kind: "session-paused" } }] });
    expect(await isSessionPaused("c@x.com")).toBe(true);
  });

  it("returns false when the latest marker is handback / resumed", async () => {
    mockStrict.mockResolvedValue({ rows: [{ raw: { kind: "human-handback" } }] });
    expect(await isThreadTakenOver("d@x.com", "111")).toBe(false);
    mockStrict.mockResolvedValue({ rows: [{ raw: { kind: "session-resumed" } }] });
    expect(await isSessionPaused("d@x.com")).toBe(false);
  });

  it("does NOT cache an unavailable read (a later successful read wins immediately)", async () => {
    mockStrict.mockResolvedValueOnce({ error: "unavailable" });
    expect(await isThreadTakenOver("e@x.com", "111")).toBe(null);
    mockStrict.mockResolvedValue({ rows: [{ raw: { kind: "human-takeover" } }] });
    expect(await isThreadTakenOver("e@x.com", "111")).toBe(true);
  });

  it("returns null (not a stale false) when the store is unavailable and only a STALE false is cached", async () => {
    // A definitive false could have flipped to taken-over on another instance
    // during the blip - returning the stale false would let the agent slip a
    // send through. Pre-seed an EXPIRED false entry, then go unavailable.
    (globalThis as { __wd_takeover_flags__?: Map<string, { paused: boolean; at: number }> })
      .__wd_takeover_flags__ = new Map([["f@x.com:111", { paused: false, at: Date.now() - 40_000 }]]);
    mockStrict.mockResolvedValue({ error: "unavailable" });
    expect(await isThreadTakenOver("f@x.com", "111")).toBe(null);
  });

  it("honors a STALE true under unavailable (keep holding - fail-closed direction)", async () => {
    (globalThis as { __wd_session_flags__?: Map<string, { paused: boolean; at: number }> })
      .__wd_session_flags__ = new Map([["g@x.com", { paused: true, at: Date.now() - 40_000 }]]);
    mockStrict.mockResolvedValue({ error: "unavailable" });
    expect(await isSessionPaused("g@x.com")).toBe(true);
  });
});
