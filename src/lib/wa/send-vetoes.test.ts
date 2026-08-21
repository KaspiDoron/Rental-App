import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P0-B.
//
// Three exactly-once / veto seams that the Evolution path had and the others
// did not: the Cloud webhook stored without any claim (so every Meta retry
// duplicated a shop's message), the recovery sweep mirrored rows off a stale
// snapshot, and BOTH send paths re-asked "was this cancelled?" at the last
// instant while never re-asking the equally absolute "did a human take over?".

describe("the Meta webhook stores exactly once and drops nothing silently", () => {
  const route = readCode("src/app/api/webhooks/whatsapp/route.ts");

  it("THE DOUBLE-STORE: every row is claimed before it is written", () => {
    expect(route).toMatch(/claimInboundStore\(String\(r\.wa_message_id \?\? ""\), owner\)/);
    // The unclaimed bulk insert must stay gone.
    expect(route).not.toMatch(/await sbInsert\("whatsapp_messages", rows\)/);
  });

  it("a failed store hands the claims BACK, or the batch can never be retried", () => {
    // A claim saying "stored" for a row that is not in the table would make
    // Meta's retry a no-op and lose the message permanently.
    const block = route.slice(route.indexOf("if (fresh.length)"));
    expect(block.slice(0, 900)).toMatch(/releaseInboundStore/);
    expect(block.slice(0, 900)).toMatch(/status: 503/);
  });

  it("THE SILENT TAIL: the bound is a clock, and the overflow is recorded", () => {
    // `inbound.slice(0, 3)` threw away messages 4+ with no trace, and there is
    // no wa-sync sweep behind the Cloud channel to recover them.
    expect(route).toMatch(/for \(const \{ msg, receiver \} of inbound\) \{/);
    expect(route).not.toMatch(/of inbound\.slice\(0, 3\)\)/);
    expect(route).toMatch(/PROCESS_BUDGET_MS/);
    expect(route).toMatch(/"meta-batch-overflow"/);
    expect(route).toMatch(/retryable: true/);
  });
});

describe("the recovery sweep cannot double-write a live webhook's row", () => {
  it("the mirror is claimed, not just snapshot-checked", () => {
    const sync = readCode("src/lib/wa-sync.ts");
    expect(sync).toMatch(/!seenIds\.has\(m\.id\) && \(await claimInboundStore\(m\.id, email\)\)/);
  });
});

describe("a human typing in the thread stops the send, in BOTH paths", () => {
  it("the drain re-asks at the last instant, and HOLDS rather than kills", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    const recheck = guard.slice(guard.indexOf("const { isCancelled } = await import(\"./wa/cancellations\")"));
    expect(recheck.slice(0, 2000)).toMatch(/isThreadTakenOver\(row\.sender_key, row\.to_number\)/);
    // A takeover is a pause, not a removal: the row must wait for handback.
    expect(recheck.slice(0, 2000)).toMatch(/reason: "human-takeover"/);
    expect(recheck.slice(0, 2000)).not.toMatch(/human-takeover"[\s\S]{0,120}completeOutboxRow/);
  });

  it("the engine's live send re-asks too, and blocks", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    const recheck = engine.slice(engine.indexOf("LAST-INSTANT cancellation re-check"));
    expect(recheck.slice(0, 1600)).toMatch(/isThreadTakenOver\(senderKey, toNumber\)/);
    expect(recheck.slice(0, 1600)).toMatch(/detail: "human-takeover/);
  });

  it("BOTH last-instant re-checks fail CLOSED - `!== false`, never `=== true`", () => {
    // isThreadTakenOver is tri-state on purpose: null means "unknown". Testing
    // `=== true` would let a DB blip license a send over a human.
    const guard = readCode("src/lib/wa-guard.ts");
    const drain = guard.slice(guard.indexOf("the user removed it - it is gone for good"));
    expect(drain.slice(0, 1400)).toMatch(/takenOver !== false/);
    const engine = readCode("src/lib/graph/engine.ts");
    const live = engine.slice(engine.indexOf("LAST-INSTANT cancellation re-check"));
    expect(live.slice(0, 1600)).toMatch(/isThreadTakenOver\(senderKey, toNumber\)\) !== false/);
  });

  it("the COMPOSE-time gate keeps its own null arm - this adds to it, never replaces it", () => {
    // The guard already refused a known takeover at compose time and held on
    // an unknown one. The new re-check narrows the window between that verdict
    // and the wire; it must not have quietly displaced the original.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/takeover === true/);
    expect(guard).toMatch(/takeover === null/);
    expect(guard).toMatch(/takeover-send-blocked/);
  });

  it("EXECUTED: the tri-state really does answer null when the store is blind", async () => {
    vi.resetModules();
    vi.doMock("./runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({ error: "unavailable" })),
      sbInsert: vi.fn(async () => true),
    }));
    vi.doMock("../runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({ error: "unavailable" })),
      sbInsert: vi.fn(async () => true),
    }));
    const { isThreadTakenOver } = await import("../session-flags");
    const verdict = await isThreadTakenOver("nobody@x.com", "66800000000");
    expect(verdict, "unknown, not false - so `!== false` holds the send").toBeNull();
    expect(verdict !== false).toBe(true);
  });
});
