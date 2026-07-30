import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { threadTurnSlot, turnBucket, TURN_WINDOW_SEC } from "./turn-lock";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// TWO LIVE FAILURES, ONE MISSING PRIMITIVE.
//
// (1) A shop sent three messages in a row and the agent answered TWICE inside
//     the same minute - two different bargains at 16:52. Every exactly-once
//     mechanism worked and none applied: claims exist per MESSAGE ID, per
//     OUTBOX ROW, per WAKEUP ROW and per MESSAGE BODY, but nothing said "this
//     thread is mid-turn". Two frames each won their own message claim, and two
//     independently composed drafts hash to two different bodies.
//
// (2) One shop out of seven never got a reply at all, with nothing in any log.
//     The reply claim was taken BEFORE the thread resolved and never released,
//     so any turn that threw left the message permanently un-replyable - and
//     the recovery sweep skips anything already STORED, never asking whether a
//     reply happened.

describe("a thread runs one turn at a time", () => {
  it("the slot is per (shop, window) and reclaimable by the existing GC", () => {
    expect(threadTurnSlot("66812345678", 5)).toBe("turn:66812345678:5");
    // NOT prefixed `msg:` - that prefix is the 72h idempotency lane, and a turn
    // lock that lived 72h would freeze the thread for three days.
    expect(threadTurnSlot("66812345678", 5).startsWith("msg:")).toBe(false);
  });

  it("normalizes the number, so one shop is one lock", () => {
    expect(threadTurnSlot("+66 81 234 5678", 1)).toBe(threadTurnSlot("66812345678", 1));
  });

  it("the window covers a full compose without stranding the next turn", () => {
    // A turn is bounded by its ~45s deadline.
    expect(TURN_WINDOW_SEC).toBeGreaterThanOrEqual(45);
    expect(TURN_WINDOW_SEC).toBeLessThanOrEqual(120);
  });

  it("moments inside one window share a bucket; the next window does not", () => {
    // Buckets are FIXED windows, not sliding ones - which is exactly why the
    // straddle check below is load-bearing: two turns a second apart can still
    // land either side of a boundary.
    const aligned = Math.floor(1_700_000_000_000 / (TURN_WINDOW_SEC * 1000)) * TURN_WINDOW_SEC * 1000;
    expect(turnBucket(aligned)).toBe(turnBucket(aligned + (TURN_WINDOW_SEC - 1) * 1000));
    expect(turnBucket(aligned)).not.toBe(turnBucket(aligned + TURN_WINDOW_SEC * 1000));
  });

  it("is straddle-proof - the previous bucket must be free too", () => {
    // DELIBERATE REWRITE: the straddle check moved into the shared
    // claimWindowSlot so the user-move window (umove:) inherits the exact
    // same proof - the invariant is unchanged, its spelling is generic.
    const src = readCode("src/lib/wa/turn-lock.ts");
    expect(src).toMatch(/slotFor\(toDigits, bucket - 1\)/);
    expect(src).toMatch(/if \(prev === "lost"\)/);
  });

  it("fails OPEN - a missing claim table must never silence a shop", () => {
    const src = readCode("src/lib/wa/turn-lock.ts");
    expect(src).toMatch(/error === "missing"\) return "won"/);
  });

  it("rides the existing claims table, so there is no migration", () => {
    expect(readCode("src/lib/wa/turn-lock.ts")).toMatch(/sbInsertClaim\("wa_send_claims"/);
  });
});

describe("the reply claim is a LEASE, not a tombstone", () => {
  const loop = () => readCode("src/lib/agent-loop.ts");

  it("is taken only AFTER the thread resolves", () => {
    // Taken at the top, a message we do not even own burned its only chance.
    const src = loop();
    const resolveAt = src.indexOf("const resolved = await resolveThreadContext");
    const claimAt = src.indexOf('sbInsertReturning<{ wa_message_id: string }>("wa_processed"');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(resolveAt);
  });

  it("is handed back when the turn did not deliver", () => {
    const src = loop();
    expect(src).toMatch(/releaseReplyClaim/);
    expect(src).toMatch(/if \(claimedReply && !turnDelivered && opts\.waMessageId\)/);
  });

  it("...and the release actually deletes the row", () => {
    const c = readCode("src/lib/wa/inbound-claim.ts");
    expect(c).toMatch(/export async function releaseReplyClaim/);
    expect(c).toMatch(/sbDelete\("wa_processed"/);
  });

  it("a turn that reached an engine KEEPS the claim, so redelivery cannot loop", () => {
    expect(loop()).toMatch(/turnDelivered = true;/);
  });

  it("the thread lock is released however the turn ends", () => {
    const src = loop();
    expect(src).toMatch(/} finally {/);
    expect(src).toMatch(/if \(holdsTurn\) await releaseThreadTurn\(/);
  });

  it("a losing turn stands down instead of composing a second reply", () => {
    const src = loop();
    expect(src).toMatch(/if \(turn === "lost"\)/);
    expect(src).toMatch(/"turn-in-flight"/);
    // ...and gives the message back, so the winner's coalesced turn answers it.
    expect(src).toMatch(/another delivery is mid-turn/);
  });
});
