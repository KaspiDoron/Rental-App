import { describe, it, expect } from "vitest";
import { needsRepark } from "./outbox-policy";

describe("needsRepark (drain must never silently lose a claimed row)", () => {
  it("does NOT re-park when the message is being sent", () => {
    expect(needsRepark({ allow: true })).toBe(false);
  });

  it("does NOT re-park when the guard already re-queued it", () => {
    expect(needsRepark({ allow: false, queuedUntil: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("does NOT re-park a deliberate terminal drop (cancelled / duplicate / rfq / takeover)", () => {
    expect(needsRepark({ allow: false, terminal: true })).toBe(false);
  });

  it("RE-PARKS a non-terminal reject that forgot to re-queue (the data-loss bug)", () => {
    // This is the exact shape the old daily-cap / circuit-breaker branches
    // returned: allow:false, no queuedUntil, no terminal. Without re-parking,
    // the already-claimed (deleted) row was lost forever.
    expect(needsRepark({ allow: false })).toBe(true);
  });

  it("prefers terminal over an absent queue (a terminal drop is never resurrected)", () => {
    expect(needsRepark({ allow: false, terminal: true, queuedUntil: undefined })).toBe(false);
  });
});
