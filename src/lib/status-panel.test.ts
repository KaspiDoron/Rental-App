import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// "I CAN'T SEE THE STATUS PANEL WHILE THE RENTAL SHOPS WRITE ME."
//
// Not a flaky effect. The panel was structurally guaranteed to be shut at
// exactly that moment, by three compounding facts:
//
//   1. `autoOpenedRef` latched per MOUNT, so the auto-open could fire at most
//      once ever, whatever happened afterwards.
//   2. Its predicate matched only OUTBOUND states - queued, rfq-sent,
//      awaiting-response - so the single open it was allowed spent itself as
//      soon as the first message left.
//   3. When a shop replied the stage advanced to negotiating / counter-offer or
//      an offer landed; the predicate went false, and the latch was gone.
//
// And the escape hatch was not one: StatusFab only called scrollIntoView, so
// tapping "Live status" scrolled forty shops back to a COLLAPSED bar - the
// exact thing that was reported.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const page = readCode("src/app/page.tsx");

/**
 * The auto-open predicate, replicated. It lives inline in a 4000-line client
 * component that this harness cannot render, so the DECISION is executed here
 * and the source assertions below pin that the page still makes it.
 */
type V = { offer?: unknown; lastInboundAt?: string; stage?: string };
const inboundLevel = (vendors: V[]) =>
  vendors.reduce(
    (n, v) =>
      n +
      (v.offer ? 1 : 0) +
      (v.lastInboundAt || v.stage === "negotiating" || v.stage === "counter-offer" ? 1 : 0),
    0
  );

/** Drive the effect's logic across a sequence of vendor snapshots. */
function run(snapshots: V[][]): { opens: number; openedAt: number[] } {
  let prev: number | null = null;
  let opens = 0;
  const openedAt: number[] = [];
  snapshots.forEach((vs, i) => {
    const level = inboundLevel(vs);
    const before = prev;
    prev = level;
    if (before === null) return;
    if (level > before) {
      opens++;
      openedAt.push(i);
    }
  });
  return { opens, openedAt };
}

describe("REPRODUCTION: the old predicate could not fire on an inbound event", () => {
  it("outbound-only + latched-per-mount means shut for the whole conversation", () => {
    const oldPredicate = (vs: V[]) =>
      vs.some(
        (v) =>
          (v as { queuedUntil?: string }).queuedUntil ||
          v.stage === "rfq-sent" ||
          v.stage === "awaiting-response"
      );
    let latch = false;
    let opens = 0;
    const timeline: V[][] = [
      [{ stage: "rfq-sent" }], // sent - the one open it was ever allowed
      [{ stage: "awaiting-response" }],
      [{ stage: "negotiating", lastInboundAt: "t1" }], // SHOP WRITES
      [{ stage: "counter-offer", lastInboundAt: "t2" }], // SHOP WRITES AGAIN
      [{ stage: "counter-offer", lastInboundAt: "t2", offer: { pricePerDay: 300 } }], // OFFER
    ];
    for (const vs of timeline) {
      if (latch) continue;
      if (oldPredicate(vs)) {
        latch = true;
        opens++;
      }
    }
    expect(opens, "one open, and it happened before any shop had said a word").toBe(1);
    // The three inbound events - the only ones the traveller asked to see -
    // produced nothing at all.
  });
});

describe("the panel opens on every inbound transition", () => {
  it("a first reply opens it", () => {
    const r = run([[{ stage: "rfq-sent" }], [{ stage: "negotiating", lastInboundAt: "t1" }]]);
    expect(r.opens).toBe(1);
  });

  it("a SECOND shop writing opens it again, even after a manual collapse", () => {
    // The reopen is unconditional on each increase, which IS the persisted
    // collapse: whatever the traveller did stands until new news arrives.
    const r = run([
      [{ stage: "rfq-sent" }, { stage: "rfq-sent" }],
      [{ stage: "negotiating", lastInboundAt: "t1" }, { stage: "rfq-sent" }],
      [{ stage: "negotiating", lastInboundAt: "t1" }, { stage: "negotiating", lastInboundAt: "t2" }],
    ]);
    expect(r.opens).toBe(2);
    expect(r.openedAt).toEqual([1, 2]);
  });

  it("an offer landing counts as news even from an already-replying shop", () => {
    const r = run([
      [{ stage: "negotiating", lastInboundAt: "t1" }],
      [{ stage: "negotiating", lastInboundAt: "t1", offer: { pricePerDay: 300 } }],
    ]);
    expect(r.opens).toBe(1);
  });

  it("polling with NO new inbound never re-opens - a collapse has to stick", () => {
    const steady: V[] = [{ stage: "negotiating", lastInboundAt: "t1" }];
    const r = run([steady, steady, steady, steady, steady]);
    expect(r.opens, "reopening on every 6s poll would be unusable").toBe(0);
  });

  it("the FIRST observation is a baseline, not an event", () => {
    // Cold-loading into a hunt that already has five replies must not fight the
    // traveller's own choice of what to look at.
    const r = run([
      [
        { stage: "negotiating", lastInboundAt: "t1" },
        { stage: "counter-offer", lastInboundAt: "t2" },
        { offer: {}, lastInboundAt: "t3" },
      ],
    ]);
    expect(r.opens).toBe(0);
  });

  it("a shop going quiet does not open it either - only increases are news", () => {
    const r = run([
      [{ stage: "negotiating", lastInboundAt: "t1" }, { stage: "negotiating", lastInboundAt: "t2" }],
      [{ stage: "negotiating", lastInboundAt: "t1" }],
    ]);
    expect(r.opens).toBe(0);
  });
});

describe("the page still makes that decision", () => {
  it("an inbound level is computed and an increase opens the panel", () => {
    expect(page).toMatch(/const inboundLevel = useMemo\(/);
    expect(page).toMatch(/lastInboundLevelRef/);
    expect(page).toMatch(/if \(inboundLevel > prev\) setStatusOpen\(true\)/);
    // The baseline guard, without which a cold load slams the panel open.
    expect(page).toMatch(/if \(prev === null\) return;/);
  });

  it("the outbound first-open still exists - it was never the broken half", () => {
    expect(page).toMatch(/if \(autoOpenedRef\.current\) return;/);
  });

  it("StatusFab opens as well as scrolls", () => {
    const fab = readCode("src/components/StatusFab.tsx");
    expect(fab).toMatch(/onOpen\?\.\(\)/);
    const click = fab.slice(fab.indexOf("onClick={() => {"));
    // Order matters only for feel, but the open must be there at all: without
    // it the button scrolls to a collapsed bar.
    expect(click.indexOf("onOpen?.()")).toBeLessThan(click.indexOf("scrollIntoView"));
    expect(page).toMatch(/onOpen=\{\(\) => setStatusOpen\(true\)\}/);
  });

  it("an expander with nothing in it says so instead of not opening", () => {
    expect(page).toMatch(/Nothing is on the wire yet\./);
  });
});

describe("the three criticals on the same screen", () => {
  it("a Modal opened FROM the thread panel is not painted over by it", () => {
    const css = readCode("src/app/globals.css");
    const thread = readCode("src/components/ThreadDashboard.tsx");
    // z-[1250] beat --z-overlay: 1200, and both surfaces portal to
    // document.body, so DOM order could never have rescued it - only the number
    // decided, and the number was picked to win.
    expect(thread).not.toMatch(/z-\[1250\]/);
    expect(thread).toMatch(/layer-panel/);
    expect(css).toMatch(/--z-panel: 1100/);
    const panel = Number(/--z-panel:\s*(\d+)/.exec(css)?.[1]);
    const overlay = Number(/--z-overlay:\s*(\d+)/.exec(css)?.[1]);
    const chrome = Number(/--z-chrome:\s*(\d+)/.exec(css)?.[1]);
    expect(panel).toBeLessThan(overlay);
    expect(panel).toBeGreaterThan(chrome);
  });

  it("the activity poll cannot stack requests on itself", () => {
    expect(page).toMatch(/activityInFlight/);
    expect(page).toMatch(/if \(document\.hidden \|\| activityInFlight\.current\) return;/);
    // Cleared in a finally: a guard that can wedge true is worse than none.
    expect(page).toMatch(/finally \{\s*\n?\s*activityInFlight\.current = false;/);
  });

  it("no poll drains another traveller's queue", () => {
    for (const p of [
      "src/app/api/activity/route.ts",
      "src/app/api/replies/route.ts",
      "src/app/api/wa/status/route.ts",
    ]) {
      const code = readCode(p);
      expect(code, `${p} drainOutbox`).toMatch(/senderKey: session\.email/);
      expect(code, `${p} drainGraphWakeups`).toMatch(/userEmail: session\.email/);
    }
  });

  it("the GLOBAL drain still exists, in the places it belongs", () => {
    // Scoping the polls would orphan signed-out users' rows if nothing drained
    // globally. The heartbeat and the tick chain do, and they are workers.
    for (const p of ["src/app/api/wa/ping/route.ts", "src/app/api/wa/tick/route.ts"]) {
      const code = readCode(p);
      expect(code, p).toMatch(/drainOutbox\(/);
      expect(code, p).not.toMatch(/senderKey: session\.email/);
    }
  });
});
