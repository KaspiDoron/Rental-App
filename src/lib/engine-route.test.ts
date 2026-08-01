import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const spteRuns: string[] = [];
const graphRuns: string[] = [];
let spteOn = true;
let graphOn = true;
let spteThrows: string | null = null;

vi.mock("./spte", () => ({ engineV3Enabled: async () => spteOn }));
vi.mock("./spte/live", () => ({
  runSpteLiveTurn: async (input: { ctx: { vendorId?: string } }) => {
    if (spteThrows) throw new Error(spteThrows);
    spteRuns.push(input.ctx.vendorId ?? "?");
    return { ran: true, move: "bargain", tier: "M", delivered: "sent" };
  },
}));
vi.mock("./graph/engine", () => ({
  graphEngineEnabled: async () => graphOn,
  runGraphTurn: async (input: { ctx: { vendorId?: string } }) => {
    graphRuns.push(input.ctx.vendorId ?? "?");
  },
}));

import { runThreadTurn } from "./engine-route";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const events: Array<{ kind: string; detail?: string }> = [];
const io = {
  recordEvent: async (e: { kind: string; detail?: string }) => {
    events.push(e);
  },
} as never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const turn = (vendorId = "lll-koh-tao"): any => ({
  event: { kind: "tick", threadKey: `t@example.com:66123`, toDigits: "66123" },
  ctx: { sender: "t@example.com", vendorId, vendorName: "LLL Koh Tao" },
});

beforeEach(() => {
  spteRuns.length = 0;
  graphRuns.length = 0;
  events.length = 0;
  spteOn = true;
  graphOn = true;
  spteThrows = null;
});

// KO TAO, THE SECOND TURN.
//
// The negotiation fixes shipped in July - out-of-stock outranking a decline, a
// goodbye that cannot carry a price, one nudge at the session floor, momentum
// on a quiet thread - all live in src/lib/spte/*. They were deployed. The field
// test failed anyway.
//
// The reason is here. A thread does not only move when the shop speaks: SPTE
// schedules its own follow-ups into `graph_wakeups`, stamping
// `payload.engine = "v3"`. Nothing read that back. `drainGraphWakeups` called
// `runGraphTurn` for every tick, unconditionally - so message one of a thread
// got the fixed brain and every scheduled turn after it got the old one. It was
// invisible too: SPTE writes `engine-v3-turn` telemetry, the graph engine wrote
// nothing at all, so Ops showed an unbroken stream of healthy V3 turns.

describe("one brain answers every turn", () => {
  it("REPRODUCTION: a wakeup turn runs SPTE, not the pre-fix graph engine", async () => {
    const out = await runThreadTurn(turn(), io, "wakeup");
    expect(out.engine).toBe("v3");
    expect(spteRuns).toEqual(["lll-koh-tao"]);
    expect(graphRuns).toEqual([]);
  });

  it("an inbound reply routes exactly the same way", async () => {
    const out = await runThreadTurn(turn(), io, "inbound");
    expect(out.engine).toBe("v3");
    expect(graphRuns).toEqual([]);
  });

  it("the wakeup drain no longer calls the graph engine directly for a tick", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    const drain = engine.slice(engine.indexOf("export async function drainGraphWakeups"));
    const tickBranch = drain.slice(drain.indexOf('row.kind === "tick"'), drain.indexOf('row.kind === "judge"'));
    expect(tickBranch).toMatch(/runThreadTurn\(input, liveGraphIO\(send\), "wakeup"\)/);
    expect(tickBranch).not.toMatch(/runGraphTurn\(/);
  });

  it("and the inbound path routes through the same one function", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/runThreadTurn\(turnInput, io, "inbound"\)/);
    // No second, divergent copy of the ladder left behind in the loop.
    expect(loop).not.toMatch(/runSpteLiveTurn\(/);
  });
});

describe("the fallback still catches a broken SPTE - and says so", () => {
  it("an SPTE that throws before sending fails over to the graph engine", async () => {
    spteThrows = "blackboard read failed";
    const out = await runThreadTurn(turn(), io, "wakeup");
    expect(out.engine).toBe("graph");
    expect(graphRuns).toEqual(["lll-koh-tao"]);
    expect(out.fallbackReason).toMatch(/blackboard read failed/);
  });

  it("the failover names the shop, the entry point and the cause", async () => {
    spteThrows = "blackboard read failed";
    await runThreadTurn(turn(), io, "wakeup");
    const fallback = events.find((e) => e.kind === "engine-v3-fallback");
    expect(fallback?.detail).toMatch(/\(wakeup\)/);
    expect(fallback?.detail).toMatch(/blackboard read failed/);
  });

  it("a graph-engine turn is no longer invisible to Ops", async () => {
    spteThrows = "boom";
    await runThreadTurn(turn(), io, "wakeup");
    const graphEvent = events.find((e) => e.kind === "engine-graph-turn");
    expect(graphEvent).toBeTruthy();
    expect(graphEvent?.detail).toMatch(/wakeup/);
  });

  it("the owner kill switch still rolls back to the graph engine", async () => {
    spteOn = false;
    const out = await runThreadTurn(turn(), io, "inbound");
    expect(out.engine).toBe("graph");
    expect(spteRuns).toEqual([]);
    expect(events.some((e) => e.kind === "engine-graph-turn")).toBe(true);
  });

  it("both engines off reports 'none' so the caller can fall through", async () => {
    spteOn = false;
    graphOn = false;
    const out = await runThreadTurn(turn(), io, "inbound");
    expect(out.engine).toBe("none");
    expect(graphRuns).toEqual([]);
  });

  it("SPTE never double-runs when it succeeds", async () => {
    await runThreadTurn(turn(), io, "wakeup");
    expect(spteRuns.length).toBe(1);
    expect(events.some((e) => e.kind === "engine-graph-turn")).toBe(false);
  });
});
