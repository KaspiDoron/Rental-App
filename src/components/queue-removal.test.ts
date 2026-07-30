import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// TWO INCIDENTS PINNED HERE.
//
// 1. Remove, and the shop pops into "CONTACTING" for a second first - a local
//    decision one view respected and another did not (the poll reverted the
//    optimistic removal; the partition's removed branch lost to a stale
//    schedule).
// 2. "REMOVED BY YOU (6)" over shops the traveller never touched - the
//    tombstone list carried no ACTOR, so the system's own session-close and
//    guard drops were rendered as user removals. The actor now decides the
//    bucket: only reason === "user-removed" may say "Removed by you".

// A faithful transcription of the status partition in src/app/page.tsx. The
// component cannot be mounted here (no DOM harness in this repo), so the rule
// is mirrored and the source is pinned below to keep the two honest.
type V = {
  id: string;
  offer?: unknown;
  lastInboundAt?: number;
  stage?: string;
  cancelled?: boolean;
  cancelReason?: string;
  sentText?: string;
  queuedUntil?: string;
  lastEventAt?: number;
};

function bucketOf(v: V): string {
  if (v.offer) return "deals";
  if (v.lastInboundAt || v.stage === "negotiating" || v.stage === "counter-offer") return "replied";
  if (v.cancelled && v.cancelReason === "user-removed" && !v.sentText) return "removed";
  if (v.cancelled && !v.sentText) return "none"; // system tombstone: a search result again
  if (["awaiting-response", "negotiating"].includes(v.stage ?? "")) return "messaged";
  if (v.stage === "sending" || v.queuedUntil) return "queued";
  if (v.stage === "rfq-sent") return "messaged";
  if (v.sentText || v.lastEventAt) return "messaged";
  return "none";
}

describe("a removal outranks the schedule it removed", () => {
  it("a just-removed shop goes straight to REMOVED BY YOU", () => {
    // The exact state one tap produces: cancelled by the USER, but the row it
    // cancelled is still on the card for a moment.
    expect(
      bucketOf({
        id: "v1",
        cancelled: true,
        cancelReason: "user-removed",
        queuedUntil: "2026-07-28T19:17:00Z",
        stage: "queued",
      })
    ).toBe("removed");
  });

  it("...even mid-send, and even with a stale stage", () => {
    expect(bucketOf({ id: "v1", cancelled: true, cancelReason: "user-removed", stage: "sending" })).toBe("removed");
    expect(bucketOf({ id: "v1", cancelled: true, cancelReason: "user-removed", stage: "rfq-sent" })).toBe("removed");
  });

  it("a shop that WAS actually messaged is not 'removed' - it was contacted", () => {
    // `sentText` is the only field that records words reaching a shop, so it
    // remains the one thing that outranks the cancellation.
    expect(
      bucketOf({
        id: "v1",
        cancelled: true,
        cancelReason: "user-removed",
        sentText: "hi",
        stage: "awaiting-response",
      })
    ).toBe("messaged");
  });

  it("a live queued shop is still CONTACTING", () => {
    expect(bucketOf({ id: "v1", queuedUntil: "2026-07-28T16:30:00Z" })).toBe("queued");
  });

  it("the partition in the page matches this rule", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(
      /else if \(v\.cancelled && v\.cancelReason === "user-removed" && !v\.sentText\) removed\.push\(v\);/
    );
    // The condition that caused the flicker must not come back.
    expect(p).not.toMatch(/v\.cancelled && !v\.sentText && !v\.queuedUntil/);
    // ...and "removed" is still tested BEFORE the queued branch.
    expect(p.indexOf("removed.push(v)")).toBeLessThan(p.indexOf("queued.push(v)"));
  });
});

describe("the actor decides the bucket (the ghost-removal incident)", () => {
  it("a SYSTEM tombstone on a never-messaged shop is NOT 'Removed by you'", () => {
    // The incident: session-close tombstoned six shops ("session-closed") and
    // the client blamed the traveller for all of them.
    for (const reason of ["session-closed", "deal-closed", "unknown", undefined]) {
      const bucket = bucketOf({ id: "v1", cancelled: true, cancelReason: reason });
      expect(bucket).not.toBe("removed");
    }
  });

  it("the page carries the actor on the vendor and only local taps default to user-removed", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/\? \("user-removed" as const\)/); // local optimistic removal
    expect(p).toMatch(/serverInfo\?\.reason \?\? "unknown"/); // server tombstones keep theirs
  });

  it("a poll cannot un-remove a shop the traveller just removed", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/const tombstonedVendor = pendingRemovals\.current\.has\(`v:\$\{v\.id\}`\)/);
    expect(p).toMatch(/tombstonedVendor \|\| Boolean\(digits && cancelledDigits\.has\(digits\)\)/);
    // ...and the stale schedule goes with it - for EVERY tombstone, whoever
    // wrote it - so nothing cancelled can read as CONTACTING.
    expect(p).toMatch(/if \(isCancelled && \(base\.queuedUntil \|\| base\.queuedReason\)\)/);
    expect(p).toMatch(/queuedUntil: undefined, queuedReason: undefined/);
  });

  it("the batch-result loop is exhaustive - a refusal is never dropped on the floor", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/startsWith\("still-removed"\)/);
    // The final else: every unclassified reason is counted and surfaced.
    expect(p).toMatch(/notSent \+= 1;/);
    expect(p).toMatch(/notSentReason/);
  });
});

describe("REMOVED BY YOU is a notice, not a wall", () => {
  it("it can be dismissed, and the dismissal SURVIVES a remount", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/const \[dismissedRemovals, setDismissedRemovals\]/);
    expect(p).toMatch(/onClick=\{dismissRemoved\}/);
    expect(p).toMatch(/\{t\("Dismiss"\)\}/);
    // Persistence: TabBar navigation is a full document load and the vendors
    // are restored from sessionStorage - a bare in-memory set made DISMISS
    // read as "does nothing". See src/lib/client/dismissals.ts.
    expect(p).toMatch(/loadDismissals\(typeof window !== "undefined" \? window\.sessionStorage : null\)/);
    expect(p).toMatch(/saveDismissals\(typeof window !== "undefined" \? window\.sessionStorage : null, next\)/);
  });

  it("dismissal is per (shop, tombstone), so a LATER removal brings it back", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/!dismissedRemovals\.has\(dismissalKey\(v\.id, v\.cancelledAt\)\)/);
    expect(p).toMatch(/next\.add\(dismissalKey\(v\.id, v\.cancelledAt\)\)/);
    // The section renders the FILTERED list, not the raw group.
    expect(p).toMatch(/\{visibleRemoved\.length > 0 && \(/);
    expect(p).toMatch(/visibleRemoved\.map\(\(v\) => v\.name\)\.join\(", "\)/);
  });

  it("the dismissed set behaves as claimed", () => {
    // The rule, exercised rather than only pinned: dismiss what is on screen,
    // and a new removal (same shop, new tombstone) is not covered by it.
    const key = (id: string, at?: string) => `${id}|${at ?? "local"}`;
    const dismissed = new Set<string>();
    const removed = [
      { id: "a", at: "2026-07-29T11:16:00Z" },
      { id: "b", at: undefined as string | undefined },
    ];
    const visible = () => removed.filter((v) => !dismissed.has(key(v.id, v.at)));
    expect(visible()).toHaveLength(2);
    for (const v of removed) dismissed.add(key(v.id, v.at));
    expect(visible()).toHaveLength(0);
    removed.push({ id: "a", at: "2026-07-30T09:00:00Z" }); // removed AGAIN later
    expect(visible().map((v) => v.id)).toEqual(["a"]);
  });
});
