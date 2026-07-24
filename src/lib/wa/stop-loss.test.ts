import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Capture the durable writes enterBanRecovery makes.
const updates: Array<Record<string, unknown>> = [];
vi.mock("../runtime-config", () => ({
  sbUpdate: async (_t: string, _f: string, values: Record<string, unknown>) => {
    updates.push(values);
    return true;
  },
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ error: "missing" }),
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbInsertClaim: async () => "won",
  getConfig: async () => undefined,
  setConfig: async () => ({ ok: true, persistent: false }),
  supabaseConfigured: () => true,
}));

import { noteSendOutcome } from "../wa-guard";

const EMAIL = "owner@example.com";
beforeEach(() => {
  updates.length = 0;
  (globalThis as unknown as { __wd_send_streak__?: unknown }).__wd_send_streak__ = undefined;
});

describe("noteSendOutcome - send-side stop-loss circuit breaker", () => {
  it("trips ban-recovery after 3 consecutive HARD failures (and not before)", async () => {
    expect((await noteSendOutcome(EMAIL, "hard")).tripped).toBe(false);
    expect((await noteSendOutcome(EMAIL, "hard")).tripped).toBe(false);
    expect(updates.some((u) => u.paused_until)).toBe(false); // still armed, not tripped

    const r = await noteSendOutcome(EMAIL, "hard");
    expect(r.tripped).toBe(true);
    // enterBanRecovery pauses the number and drops trust to 10.
    expect(updates.some((u) => u.paused_until && u.trust_score === 10)).toBe(true);
  });

  it("an 'ok' (clean send) resets the streak so it never trips", async () => {
    await noteSendOutcome(EMAIL, "hard");
    await noteSendOutcome(EMAIL, "hard");
    await noteSendOutcome(EMAIL, "ok"); // reset
    const r = await noteSendOutcome(EMAIL, "hard");
    expect(r.tripped).toBe(false);
    expect(updates.some((u) => u.paused_until)).toBe(false);
  });

  it("scattered dead numbers (soft) never trip the breaker", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await noteSendOutcome(EMAIL, "soft")).tripped).toBe(false);
    }
    expect(updates.some((u) => u.paused_until)).toBe(false);
  });

  it("isolates per sender - one number's failures don't trip another", async () => {
    await noteSendOutcome("a@x.com", "hard");
    await noteSendOutcome("a@x.com", "hard");
    const r = await noteSendOutcome("b@x.com", "hard");
    expect(r.tripped).toBe(false);
  });
});
