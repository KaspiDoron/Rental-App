import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the anti-herd + concurrency contracts:
//  - jittered holds NEVER produce a shared release instant
//  - batch stagger is strictly increasing, 45-75s per step
//  - the claim protocol serializes concurrent senders, is idempotent per
//    message, straddle-proof at bucket boundaries, and fails CLOSED on
//    unknown claim state (while degrading to today's behavior pre-migration)

vi.mock("server-only", () => ({}));

const state: {
  claims: Map<string, number>; // key -> created_at ms
  mode: "ok" | "missing" | "unavailable";
  nowMs: number;
} = { claims: new Map(), mode: "ok", nowMs: 1_700_000_000_000 };

vi.mock("../runtime-config", () => ({
  sbInsertClaim: async (_t: string, row: { sender_key: string; slot_key: string }) => {
    if (state.mode === "unavailable") return "error" as const;
    if (state.mode === "missing") return "error" as const;
    const key = `${row.sender_key}|${row.slot_key}`;
    if (state.claims.has(key)) return "lost" as const;
    state.claims.set(key, state.nowMs);
    return "won" as const;
  },
  sbDelete: async (_t: string, query: string) => {
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    state.claims.delete(`${sender}|${slot}`);
  },
  sbSelectStrict: async (_t: string, query: string) => {
    if (state.mode === "missing") return { error: "missing" as const };
    if (state.mode === "unavailable") return { error: "unavailable" as const };
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    const slot = decodeURIComponent(/slot_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    if (slot) {
      const at = state.claims.get(`${sender}|${slot}`);
      return { rows: at ? [{ created_at: new Date(at).toISOString() }] : [] };
    }
    return { rows: [...state.claims.keys()].map(() => ({})) };
  },
}));

import {
  jitteredHold,
  staggerOffsets,
  cappedStaggerOffsets,
  gapBucket,
  claimSendSlots,
  messageSlotKey,
  gaussianUnit,
} from "./pacing";

beforeEach(() => {
  state.claims = new Map();
  state.mode = "ok";
  state.nowMs = 1_700_000_000_000;
});

describe("jitteredHold - no shared release instant", () => {
  it("stays inside [base, base+spread] minutes and varies per row", () => {
    const now = 1_700_000_000_000;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const iso = jitteredHold(now, 15, 20);
      const offsetMin = (Date.parse(iso) - now) / 60_000;
      expect(offsetMin).toBeGreaterThanOrEqual(15);
      expect(offsetMin).toBeLessThanOrEqual(35);
      seen.add(iso);
    }
    // 50 draws over a 20-minute ms-precision window collapsing to ONE value
    // is what the old flat "+15 min" did - the herd signature.
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe("staggerOffsets - the batch trickle", () => {
  it("first is immediate, every later step lands 45-75s after the previous", () => {
    const offs = staggerOffsets(10);
    expect(offs[0]).toBe(0);
    for (let i = 1; i < offs.length; i++) {
      const step = offs[i] - offs[i - 1];
      expect(step).toBeGreaterThanOrEqual(45_000);
      expect(step).toBeLessThanOrEqual(75_000);
    }
  });

  it("ten shops never share a timestamp (the '~15:27 x10' regression)", () => {
    const offs = staggerOffsets(10);
    expect(new Set(offs).size).toBe(10);
  });
});

describe("gaussianUnit - bell-curve jitter that never breaks the pacing bounds", () => {
  it("always returns a value inside [0,1] (so 45+rand*30 stays 45-75s)", () => {
    for (let i = 0; i < 5000; i++) {
      const v = gaussianUnit();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("clusters around the mean (a bell, not a flat uniform)", () => {
    let inMiddle = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = gaussianUnit(0.5, 0.22);
      if (v > 0.35 && v < 0.65) inMiddle += 1;
    }
    // A uniform draw would put ~30% in the middle 30% of the range; the
    // Gaussian concentrates clearly more mass there.
    expect(inMiddle / N).toBeGreaterThan(0.45);
  });

  it("is a drop-in rand for cappedStaggerOffsets - gaps stay within the min-gap band", () => {
    const offs = cappedStaggerOffsets(40, 40, 12, gaussianUnit);
    for (let i = 1; i < offs.length; i++) {
      const step = offs[i] - offs[i - 1];
      expect(step).toBeGreaterThanOrEqual(12_000); // >= min-gap
      expect(step).toBeLessThanOrEqual(24_000); // <= min-gap + jitter cap
    }
    expect(new Set(offs).size).toBe(40); // still no shared timestamp
  });
});

describe("cappedStaggerOffsets - honest cap-aware schedule (no optimistic-then-jump)", () => {
  it("first item is immediate", () => {
    expect(cappedStaggerOffsets(6, 3)[0]).toBe(0);
  });

  it("puts at most hourCap items inside each 1-hour window", () => {
    const cap = 3;
    const offs = cappedStaggerOffsets(8, cap);
    for (let hour = 0; hour < 3; hour++) {
      const lo = hour * 3600_000;
      const hi = (hour + 1) * 3600_000;
      const inWindow = offs.filter((o) => o >= lo && o < hi).length;
      expect(inWindow).toBeLessThanOrEqual(cap);
    }
  });

  it("stamps the overflow at the NEXT hour boundary, not 'any minute'", () => {
    const offs = cappedStaggerOffsets(6, 3); // items 3,4,5 spill to hour 2
    // items 0-2 in the first hour (< 1h), items 3-5 at/after +1h
    expect(offs[2]).toBeLessThan(3600_000);
    expect(offs[3]).toBeGreaterThanOrEqual(3600_000);
    expect(offs[5]).toBeGreaterThanOrEqual(3600_000);
    expect(offs[5]).toBeLessThan(2 * 3600_000);
  });

  it("within an hour the sends are spaced (never a shared timestamp)", () => {
    const offs = cappedStaggerOffsets(3, 3);
    expect(new Set(offs).size).toBe(3);
    expect(offs[1]).toBeGreaterThan(offs[0]);
    expect(offs[2]).toBeGreaterThan(offs[1]);
  });

  it("a full 40-intro ultra batch at a 12s min-gap clears well inside 15 min, strictly in order", () => {
    const offs = cappedStaggerOffsets(40, 40, 12);
    // Every intro fits in the first hour group (hourCap 40 == batch size).
    expect(offs.every((o) => o < 3600_000)).toBe(true);
    // Strictly increasing (the old per-item formula could stamp #39 before #38).
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1]);
    // The LAST intro is due comfortably under 15 min even at max jitter.
    expect(offs[39]).toBeLessThan(15 * 60_000);
    // ...and steps stay in the 12-24s band (min-gap + <= min-gap jitter).
    for (let i = 1; i < offs.length; i++) {
      const step = offs[i] - offs[i - 1];
      expect(step).toBeGreaterThanOrEqual(12_000);
      expect(step).toBeLessThanOrEqual(24_000);
    }
  });

  it("hourCap of 1 (a heavily warmed-down number) spaces ~one per hour, past each boundary", () => {
    const offs = cappedStaggerOffsets(3, 1);
    expect(offs[0]).toBe(0);
    // Each new hour-group lands just PAST the 1-hour boundary (a min-gap buffer)
    // so the prior send has aged out of the drain's rolling window.
    expect(offs[1]).toBeGreaterThan(3600_000);
    expect(offs[1]).toBeLessThan(3600_000 + 5 * 60_000);
    expect(offs[2]).toBeGreaterThan(2 * 3600_000);
    expect(offs[2]).toBeLessThan(2 * 3600_000 + 5 * 60_000);
  });
});

describe("claimSendSlots - lock-free serialization", () => {
  const base = {
    senderKey: "a@x.com",
    toDigits: "66812345678",
    text: "hello shop",
    auto: true,
    gapSeconds: 60,
  };

  it("two concurrent invocations in the same gap window: exactly one wins", async () => {
    const first = await claimSendSlots({ ...base, nowMs: state.nowMs });
    const second = await claimSendSlots({ ...base, text: "different text", nowMs: state.nowMs + 1000 });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, kind: "pacing" });
  });

  it("identical message: the loser is a duplicate, not a pacing hold", async () => {
    const first = await claimSendSlots({ ...base, nowMs: state.nowMs });
    const dup = await claimSendSlots({ ...base, nowMs: state.nowMs + 1000 });
    expect(first.ok).toBe(true);
    expect(dup).toEqual({ ok: false, kind: "duplicate" });
  });

  it("bucket-boundary straddle is refused (send at gap*0.98 then gap*1.02)", async () => {
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000); // bucket-aligned
    state.nowMs = t0 + 59_000;
    const first = await claimSendSlots({ ...base, nowMs: t0 + 59_000 });
    expect(first.ok).toBe(true);
    state.nowMs = t0 + 61_000; // next bucket, but only 2s later
    const second = await claimSendSlots({ ...base, text: "other", nowMs: t0 + 61_000 });
    expect(second).toEqual({ ok: false, kind: "pacing" });
  });

  it("a FULL gap after the previous send passes across the boundary", async () => {
    const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    state.nowMs = t0 + 10_000;
    expect((await claimSendSlots({ ...base, nowMs: t0 + 10_000 })).ok).toBe(true);
    state.nowMs = t0 + 75_000; // 65s later, next bucket
    expect((await claimSendSlots({ ...base, text: "other", nowMs: t0 + 75_000 })).ok).toBe(true);
  });

  it("manual sends take only the idempotency slot (no pacing serialization)", async () => {
    const a = await claimSendSlots({ ...base, auto: false, nowMs: state.nowMs });
    const b = await claimSendSlots({ ...base, auto: false, text: "second manual", nowMs: state.nowMs + 500 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // two different manual messages, same window - fine
  });

  it("fails CLOSED on unknown claim state, degrades OPEN pre-migration", async () => {
    state.mode = "unavailable";
    expect(await claimSendSlots({ ...base, nowMs: state.nowMs })).toEqual({
      ok: false,
      kind: "error",
    });
    state.mode = "missing";
    expect((await claimSendSlots({ ...base, nowMs: state.nowMs })).ok).toBe(true);
  });

  it("a pacing loser releases its message claim so the retry can re-claim", async () => {
    await claimSendSlots({ ...base, nowMs: state.nowMs });
    const lost = await claimSendSlots({ ...base, text: "retry me", nowMs: state.nowMs + 1000 });
    expect(lost).toEqual({ ok: false, kind: "pacing" });
    // The loser's msg slot must be free again for the queued retry.
    expect(state.claims.has(`a@x.com|${messageSlotKey("66812345678", "retry me")}`)).toBe(false);
  });
});

describe("claimSendSlots - per-recipient REPLY lane (concurrent negotiations)", () => {
  const common = { senderKey: "u@x.com", auto: true, gapSeconds: 12 };
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 12_000); // bucket-aligned

  it("two DIFFERENT engaged shops both send in the same window", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "reply to shop A",
      perRecipient: true,
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "222222",
      text: "reply to shop B",
      perRecipient: true,
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // distinct recipients no longer serialize
  });

  it("the SAME shop is STILL min-gap serialized in the reply lane", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "first to A",
      perRecipient: true,
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "second to A too soon",
      perRecipient: true,
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, kind: "pacing" });
  });

  it("cold intros (no perRecipient) still serialize across recipients", async () => {
    const a = await claimSendSlots({
      ...common,
      toDigits: "111111",
      text: "cold intro A",
      nowMs: t0,
    });
    const b = await claimSendSlots({
      ...common,
      toDigits: "222222",
      text: "cold intro B",
      nowMs: t0 + 500,
    });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, kind: "pacing" }); // per-sender velocity lane
  });
});

describe("claimSendSlots - reply FLEET ceiling (atomic total-velocity cap)", () => {
  const common = { senderKey: "u@x.com", auto: true, gapSeconds: 12, perRecipient: true, fleetGapSeconds: 6 };
  const t0 = 1_700_000_000_000 - (1_700_000_000_000 % 12_000); // aligned to 12s (and 6s)

  it("two DIFFERENT shops do NOT both send in the same fleet window (no burst)", async () => {
    const a = await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    const b = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 500 });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, kind: "pacing" }); // fleet slot atomically serialized them
  });

  it("once the fleet gap passes, the next shop sends", async () => {
    const a = await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    const b = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 7000 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true); // next 6s fleet bucket
  });

  it("a fleet loser frees its message + recipient slots for the retry", async () => {
    await claimSendSlots({ ...common, toDigits: "111111", text: "A", nowMs: t0 });
    const lost = await claimSendSlots({ ...common, toDigits: "222222", text: "B", nowMs: t0 + 500 });
    expect(lost).toEqual({ ok: false, kind: "pacing" });
    expect(state.claims.has(`u@x.com|${messageSlotKey("222222", "B")}`)).toBe(false);
  });
});

describe("gapBucket", () => {
  it("is stable within a window and increments across it", () => {
    expect(gapBucket(120_000, 60)).toBe(2);
    expect(gapBucket(179_999, 60)).toBe(2);
    expect(gapBucket(180_000, 60)).toBe(3);
  });
});
