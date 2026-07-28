import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// REMOVE, AND THE SHOP POPS INTO "CONTACTING" FOR A SECOND FIRST.
//
// Two independent causes, both the same shape: a local decision that one view
// respected and another did not.
//
//   1. The poll. `pendingRemovals` suppressed the removed QUEUE row, and the
//      vendor merge then recomputed `cancelled` straight from the server's
//      cancelled list - which a poll started before the delete committed still
//      answers "no". So the optimistic removal was reverted for one cycle,
//      `queuedUntil` came back with it, and the shop rendered as CONTACTING.
//   2. The partition. The "removed" branch required `!v.queuedUntil`, so a shop
//      still carrying the stale schedule of the very message being deleted
//      failed the test and fell through to the CONTACTING branch below it.

// A faithful transcription of the status partition in src/app/page.tsx. The
// component cannot be mounted here (no DOM harness in this repo), so the rule
// is mirrored and the source is pinned below to keep the two honest.
type V = {
  id: string;
  offer?: unknown;
  lastInboundAt?: number;
  stage?: string;
  cancelled?: boolean;
  sentText?: string;
  queuedUntil?: string;
  lastEventAt?: number;
};

function bucketOf(v: V): string {
  if (v.offer) return "deals";
  if (v.lastInboundAt || v.stage === "negotiating" || v.stage === "counter-offer") return "replied";
  if (v.cancelled && !v.sentText) return "removed";
  if (["awaiting-response", "negotiating"].includes(v.stage ?? "")) return "messaged";
  if (v.stage === "sending" || v.queuedUntil) return "queued";
  if (v.stage === "rfq-sent") return "messaged";
  if (v.sentText || v.lastEventAt) return "messaged";
  return "none";
}

describe("a removal outranks the schedule it removed", () => {
  it("a just-removed shop goes straight to REMOVED BY YOU", () => {
    // The exact state one tap produces: cancelled, but the row it cancelled is
    // still on the card for a moment.
    expect(
      bucketOf({ id: "v1", cancelled: true, queuedUntil: "2026-07-28T19:17:00Z", stage: "queued" })
    ).toBe("removed");
  });

  it("...even mid-send, and even with a stale stage", () => {
    expect(bucketOf({ id: "v1", cancelled: true, stage: "sending" })).toBe("removed");
    expect(bucketOf({ id: "v1", cancelled: true, stage: "rfq-sent" })).toBe("removed");
  });

  it("a shop that WAS actually messaged is not 'removed' - it was contacted", () => {
    // `sentText` is the only field that records words reaching a shop, so it
    // remains the one thing that outranks the cancellation.
    expect(bucketOf({ id: "v1", cancelled: true, sentText: "hi", stage: "awaiting-response" })).toBe(
      "messaged"
    );
  });

  it("a live queued shop is still CONTACTING", () => {
    expect(bucketOf({ id: "v1", queuedUntil: "2026-07-28T16:30:00Z" })).toBe("queued");
  });

  it("the partition in the page matches this rule", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/else if \(v\.cancelled && !v\.sentText\) removed\.push\(v\);/);
    // The condition that caused the flicker must not come back.
    expect(p).not.toMatch(/v\.cancelled && !v\.sentText && !v\.queuedUntil/);
    // ...and "removed" is still tested BEFORE the queued branch.
    expect(p.indexOf("removed.push(v)")).toBeLessThan(p.indexOf("queued.push(v)"));
  });
});

describe("the tombstone covers the shop, not only its queue row", () => {
  it("a poll cannot un-remove a shop the traveller just removed", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/const tombstonedVendor = pendingRemovals\.current\.has\(`v:\$\{v\.id\}`\)/);
    expect(p).toMatch(/tombstonedVendor \|\| Boolean\(digits && cancelledDigits\.has\(digits\)\)/);
    // ...and the stale schedule goes with it, so nothing can read as CONTACTING.
    expect(p).toMatch(/queuedUntil: undefined, queuedReason: undefined/);
  });
});

describe("REMOVED BY YOU is a notice, not a wall", () => {
  it("it can be dismissed", () => {
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/const \[dismissedRemovals, setDismissedRemovals\]/);
    expect(p).toMatch(/onClick=\{dismissRemoved\}/);
    expect(p).toMatch(/\{t\("Dismiss"\)\}/);
  });

  it("dismissal is per shop, so a LATER removal brings it back", () => {
    // A single "hidden" flag would silently swallow the next removal, which is
    // the one thing a notice must never do.
    const p = readCode("src/app/page.tsx");
    expect(p).toMatch(/statusGroups\.removed\.filter\(\(v\) => !dismissedRemovals\.has\(v\.id\)\)/);
    expect(p).toMatch(/for \(const v of statusGroups\.removed\) next\.add\(v\.id\)/);
    // The section renders the FILTERED list, not the raw group.
    expect(p).toMatch(/\{visibleRemoved\.length > 0 && \(/);
    expect(p).toMatch(/visibleRemoved\.map\(\(v\) => v\.name\)\.join\(", "\)/);
  });

  it("the dismissed set behaves as claimed", () => {
    // The rule, exercised rather than only pinned: dismiss what is on screen,
    // and a new removal is not covered by it.
    const dismissed = new Set<string>();
    const removed = [{ id: "a" }, { id: "b" }];
    const visible = () => removed.filter((v) => !dismissed.has(v.id));
    expect(visible()).toHaveLength(2);
    for (const v of removed) dismissed.add(v.id);
    expect(visible()).toHaveLength(0);
    removed.push({ id: "c" });
    expect(visible().map((v) => v.id)).toEqual(["c"]);
  });
});
