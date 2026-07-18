import { describe, it, expect } from "vitest";
import { needsRepark, outboxSendPriority } from "./outbox-policy";

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

describe("outboxSendPriority (engaged shops beat the cold-intro batch)", () => {
  it("a user-typed message is sent before anything", () => {
    expect(outboxSendPriority("human-manual")).toBe(0);
    expect(outboxSendPriority("custom")).toBe(0);
  });

  it("an agent reply/bargain/answer beats a fresh rfq", () => {
    expect(outboxSendPriority("auto-answer")).toBe(1);
    expect(outboxSendPriority("auto-bargain")).toBe(1);
    expect(outboxSendPriority("rfq")).toBe(2);
    expect(outboxSendPriority("auto-answer")).toBeLessThan(outboxSendPriority("rfq"));
  });

  it("sorting a mixed due batch puts the reply ahead of two due intros", () => {
    const rows = [
      { kind: "rfq", at: "2026-01-01T00:00:00Z" },
      { kind: "rfq", at: "2026-01-01T00:00:01Z" },
      { kind: "auto-bargain", at: "2026-01-01T00:00:05Z" }, // due LATER but urgent
    ];
    const order = [...rows]
      .sort((a, b) => outboxSendPriority(a.kind) - outboxSendPriority(b.kind) || a.at.localeCompare(b.at))
      .map((r) => r.kind);
    expect(order[0]).toBe("auto-bargain");
  });

  it("unknown/undefined kinds default to reply priority (never treated as cold outreach)", () => {
    expect(outboxSendPriority(undefined)).toBe(1);
    expect(outboxSendPriority(null)).toBe(1);
  });
});
