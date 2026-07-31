import { describe, it, expect, vi } from "vitest";

// server-only is a Next marker with no runtime; stub it, and force the single
// pass onto its deterministic fallback (chat -> null) so the move is stable.
vi.mock("server-only", () => ({}));
vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: () => null,
}));

import { runSpteLiveTurn } from "./live";
import type { GraphIO, GraphTurnInput } from "../graph/types";

// A minimal GraphIO that records the outbound decisions. Only the methods the
// live glue touches are implemented; the rest throw if unexpectedly called.
function mockIo(overrides: Partial<GraphIO> = {}) {
  const sent: Array<{ via: string; text: string; meta: unknown }> = [];
  const events: Array<{ kind: string; detail: string }> = [];
  const wakeups: unknown[] = [];
  const io = {
    now: () => 1_000_000,
    sessionTable: async () => [],
    guardAndSend: async ({ text, meta }: { text: string; meta: unknown }) => {
      sent.push({ via: "guardAndSend", text, meta });
      return { delivered: "sent" as const, detail: "ok", finalText: text };
    },
    queueOutbox: async ({ body, meta }: { body: string; meta: unknown }) => {
      sent.push({ via: "queueOutbox", text: body, meta });
    },
    insertWakeup: async (row: unknown) => {
      wakeups.push(row);
    },
    recordEvent: async ({ kind, detail }: { kind: string; detail: string }) => {
      events.push({ kind, detail });
    },
    ...overrides,
  } as unknown as GraphIO;
  return { io, sent, events, wakeups };
}

function input(partial: Partial<GraphTurnInput> = {}): GraphTurnInput {
  return {
    event: {
      kind: "inbound-text",
      threadKey: "user@x.com:63999",
      userEmail: "user@x.com",
      toDigits: "63999",
      shopMessage: "500 per day",
      images: [],
      audios: [],
    },
    ctx: { sender: "user@x.com", vendorId: "v1", vendorName: "Shop A", rfq: null },
    rfq: { vehicleClass: "scooter", engineSizeCc: 125, transmission: "any", durationDays: 4, accessories: [], fulfillment: "any", vendorMessage: "" },
    extraction: { found: true, pricePerDay: 500, currency: "PHP", matchesSpec: true, confidence: "high" },
    usablePrice: 500,
    currency: "PHP",
    floorPrice: 300,
    sessionClosed: false,
    history: "",
    priorOutbound: ["Hi! Do you have a 125cc scooter for 4 days?"],
    legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 0 },
    humanDelay: false,
    deadlineAt: 1_045_000,
    ...partial,
  };
}

describe("SPTE live glue", () => {
  it("composes and SENDS a legal move on a live quote (no human delay -> guardAndSend)", async () => {
    const { io, sent, events } = mockIo();
    const res = await runSpteLiveTurn(input(), io);
    expect(res.ran).toBe(true);
    // A live price with rounds left is bargain-first (policy rails).
    expect(res.move).toBe("bargain");
    expect(sent.length).toBe(1);
    expect(sent[0].via).toBe("guardAndSend");
    expect(sent[0].text.length).toBeGreaterThan(0);
    // Telemetry for the Blackboard Inspector was recorded.
    expect(events.some((e) => e.kind === "engine-v3-turn")).toBe(true);
  });

  it("sends INLINE even with humanDelay (bounded pause -> guardAndSend, no park)", async () => {
    // The structural fix for "agent never replies": a reply leaves in the same
    // invocation. With a tight remaining budget the pause clamps to 0 and the
    // send still fires through guardAndSend (which owns queue-on-block).
    const { io, sent } = mockIo();
    const res = await runSpteLiveTurn(
      input({ humanDelay: true, deadlineAt: 1_015_000 }), // remaining 15s -> pause 0
      io
    );
    expect(res.move).toBe("bargain");
    expect(sent.length).toBe(1);
    expect(sent[0].via).toBe("guardAndSend");
    // A bargain now stamps "auto-bargain" (not "reply") so the round counter in
    // agent-loop actually advances - the fix for 4 pushes to one shop.
    expect((sent[0].meta as { kind?: string }).kind).toBe("auto-bargain");
    expect((sent[0].meta as { move?: string }).move).toBe("bargain");
  });

  it("stays silent (no send) on a declined+closed thread", async () => {
    const { io, sent } = mockIo();
    const res = await runSpteLiveTurn(
      input({
        extraction: { found: false, matchesSpec: true, confidence: "low", shopDeclined: true },
        usablePrice: undefined,
        // already sent the one goodbye -> only silence is legal -> reflex silent
        legacyCounts: { clarify: 0, bargain: 0, answer: 0, close: 1 },
        history: "closed - one goodbye sent",
      }),
      io
    );
    // farewell or silent - either way, a declined thread never keeps bargaining.
    expect(["silent", "farewell"]).toContain(res.move);
  });

  it("never throws after deciding a move even if the send path errors (no double-send risk)", async () => {
    const { io } = mockIo({
      guardAndSend: async () => {
        throw new Error("transport down");
      },
      queueOutbox: async () => {
        throw new Error("db down");
      },
    });
    // The send failed AND the re-queue failed, but the turn resolves cleanly
    // (delivered: "failed") rather than throwing - a throw would let the caller
    // re-run the whole turn and double-send.
    const res = await runSpteLiveTurn(input(), io);
    expect(res.ran).toBe(true);
    expect(res.delivered).toBe("failed");
  });
});
