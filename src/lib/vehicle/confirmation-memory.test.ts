import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveConfirmation, type VehicleConfirmationState } from "./confirmation";
import { mergeVehicleConfirmation } from "../graph/state";
import type { DeclaredVehicle } from "./identity";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE THREAD FORGOT THAT IT HAD ALREADY ASKED (W-15, the owner's item 15).
//
// `resolveConfirmation` is a one-transition-per-turn function over a DURABLE
// prior state: the ask-once latch (`askedAt`) and `confirmed` are carried
// forward in `negotiation_threads.fields.vehicleConfirmation`.
//
// Nothing wrote that field. Its only writer was `applyExtractionToState`,
// called only from the graph engine - and `engineV3Enabled` returns true even
// when config is UNREADABLE, so SPTE takes every ordinary turn and the graph
// engine effectively never runs. `prev` was therefore null on every turn, and
// the whole memory of the thread collapsed to one signal: whether the confirm
// question happened to still be our MOST RECENT outbound.
//
// One bargain later it was not, and the engine asked again. That is precisely
// what the owner watched: the shop answered "Click 125 cc yes", and two turns
// later the agent asked "Just to confirm, is the 200 baht per day quote for a
// fully automatic 125cc scooter?"

const declared: DeclaredVehicle = { class: "scooter", displacementCc: 125, transmission: "automatic" };

/** One inbound turn, as the live path runs it. */
const turn = (
  prev: VehicleConfirmationState | null,
  o: { inbound: string; lastMove: string | null; hasPrice?: boolean }
) =>
  resolveConfirmation(prev, {
    declared,
    inboundText: o.inbound,
    lastOutboundText: "",
    lastOutboundMove: o.lastMove,
    messageStatus: o.hasPrice ? "needs-confirmation" : null,
    hasPrice: Boolean(o.hasPrice),
  });

describe("REPRODUCTION: a three-turn thread, with and without memory", () => {
  // Turn 1: we sent the RFQ, the shop quotes. Nothing is confirmed yet.
  const t1 = turn(null, { inbound: "200 per day", lastMove: "rfq", hasPrice: true });
  // Turn 2: we asked the confirm question, the shop answered it.
  const t2 = (prev: VehicleConfirmationState | null) =>
    turn(prev, { inbound: "Click 125 cc yes", lastMove: "confirm-vehicle", hasPrice: true });
  // Turn 3: we bargained; the shop restates a price. Our last outbound is the
  // BARGAIN now, so nothing in this turn says we ever asked.
  const t3 = (prev: VehicleConfirmationState | null) =>
    turn(prev, { inbound: "1100b./6days", lastMove: "bargain", hasPrice: true });

  it("turn 1 is honestly assumed, not confirmed", () => {
    expect(t1.status).toBe("assumed");
    expect(t1.askedAt).toBeUndefined();
  });

  it("turn 2 confirms and latches the ask", () => {
    const s = t2(t1);
    expect(s.status).toBe("confirmed");
    expect(s.askedAt, "the ask-once latch must be stamped").toBeTruthy();
  });

  it("WITHOUT the stored state, turn 3 forgets both - the bug", () => {
    // This is the call the live path actually made: prev is null because
    // nothing ever wrote it.
    const s = t3(null);
    expect(s.status, "the thread un-confirmed itself").toBe("assumed");
    expect(s.askedAt, "the ask-once latch was lost, so confirm-vehicle is legal again").toBeUndefined();
  });

  it("WITH it, turn 3 keeps what the shop already told us", () => {
    const s = t3(t2(t1));
    expect(s.status).toBe("confirmed");
    expect(s.askedAt).toBeTruthy();
  });

  it("and a fourth turn cannot regress it either", () => {
    const s = t3(t3(t2(t1)));
    expect(s.status).toBe("confirmed");
  });
});

describe("the merge rule the two writers share", () => {
  const confirmed: VehicleConfirmationState = {
    status: "confirmed",
    evidence: "the shop named the vehicle",
    at: "2026-08-11T10:00:00.000Z",
    askedAt: "2026-08-11T09:00:00.000Z",
  };
  const assumed: VehicleConfirmationState = {
    status: "assumed",
    evidence: "quoted a price directly",
    at: "2026-08-11T11:00:00.000Z",
  };

  it("confirmed never regresses", () => {
    expect(mergeVehicleConfirmation(confirmed, assumed).status).toBe("confirmed");
  });

  it("but a later confirmation replaces an assumption", () => {
    expect(mergeVehicleConfirmation(assumed, confirmed).status).toBe("confirmed");
  });

  it("a NEW ask still latches onto an already-confirmed thread", () => {
    // Otherwise a thread confirmed by the shop naming the vehicle, then asked
    // once anyway, would have no record of the ask.
    const held: VehicleConfirmationState = { ...confirmed, askedAt: undefined };
    const merged = mergeVehicleConfirmation(held, { ...assumed, askedAt: "2026-08-11T12:00:00.000Z" });
    expect(merged.status).toBe("confirmed");
    expect(merged.askedAt).toBe("2026-08-11T12:00:00.000Z");
  });

  it("nothing prior means take the new state as-is", () => {
    expect(mergeVehicleConfirmation(undefined, assumed)).toBe(assumed);
  });
});

describe("the fact is written where it is resolved", () => {
  const loop = readCode("src/lib/agent-loop.ts");
  const state = readCode("src/lib/graph/state.ts");

  it("the inbound path persists it, not only the engine that never runs", () => {
    expect(loop).toMatch(/saveVehicleConfirmation\(/);
    // Right where `prev` is read and `conf` is produced - one place owns both
    // halves of the round trip.
    const readAt = loop.indexOf("loadThreadState(threadKeyFor(ctx.sender, from))");
    const writeAt = loop.indexOf("saveVehicleConfirmation(");
    expect(readAt).toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(readAt);
  });

  it("a failed write never costs the shop its reply", () => {
    expect(loop).toMatch(/saveVehicleConfirmation\([\s\S]{0,400}?\)\.catch\(\(\) => \{\}\)/);
  });

  it("both writers go through the one merge rule", () => {
    expect(state).toMatch(/f\.vehicleConfirmation = mergeVehicleConfirmation\(/);
    expect(state).toMatch(/const merged = mergeVehicleConfirmation\(/);
    // The old inline copy of the never-regress branch is gone.
    expect(state).not.toMatch(/prev\?\.status !== "confirmed" \|\| extraction\.vehicleConfirmation/);
  });

  it("an unchanged state does not burn a version bump", () => {
    // saveThreadState is an optimistic UPDATE ... WHERE version = n. Writing an
    // identical row on every inbound turn would churn versions and lose races
    // with the engine's own save for nothing.
    expect(state).toMatch(/merged\.status === state\.fields\.vehicleConfirmation\.status/);
  });
});
