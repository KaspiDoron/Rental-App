import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

type Row = { wa_message_id: string | null; received_at: string; body: string | null };
let inbound: Row[] = [];
const inserted: Array<{ table: string; rows: unknown[] }> = [];

vi.mock("../runtime-config", () => ({
  sbSelect: async () => inbound,
  sbInsert: async (table: string, rows: unknown[]) => {
    inserted.push({ table, rows });
    return true;
  },
}));

import { threadMovedOn, scheduleRecompose } from "./freshness-live";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const COMPOSED_AT = "2026-07-31T05:23:00.000Z"; // 12:23 ICT
const draft = {
  senderKey: "t@example.com",
  toNumber: "66123456789",
  composedAgainst: {
    inboundId: "m-12-22",
    inboundAt: COMPOSED_AT,
    quotePerDay: 180,
    stockState: "in-stock" as const,
    move: "bargain",
  },
};

beforeEach(() => {
  inbound = [];
  inserted.length = 0;
});

// KO TAO, 12:23 -> 12:39.
//
// The engine composed "that's a bit high for me..." at 12:23. At 12:38 the shop
// said something that changed everything. At 12:39 we sent the sentence anyway.
//
// A freshness guard was written for exactly this and wired into the DRAIN - the
// path that handles messages which got PARKED. But parking is the exception.
// The dominant path composes and sends in the same request after a pause of up
// to ten seconds, and it never asked the question at all. The fix existed on
// the road less travelled.

describe("the question is asked on the path that actually sends", () => {
  it("REPRODUCTION: a newer inbound makes the draft stale", async () => {
    inbound = [
      { wa_message_id: "m-12-38", received_at: "2026-07-31T05:38:00.000Z", body: "no free bikes" },
      { wa_message_id: "m-12-22", received_at: "2026-07-31T05:22:00.000Z", body: "180 baht" },
    ];
    const v = await threadMovedOn(draft);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("newer-inbound");
  });

  it("nothing new since we wrote it - it still goes out", async () => {
    inbound = [
      { wa_message_id: "m-12-22", received_at: "2026-07-31T05:22:00.000Z", body: "180 baht" },
    ];
    expect((await threadMovedOn(draft)).stale).toBe(false);
  });

  it("the inline send path runs it milliseconds before the network call", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    const send = engine.slice(engine.indexOf("async guardAndSend("));
    const check = send.indexOf("threadMovedOn(");
    const network = send.indexOf("result = await send(senderKey, toNumber");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(network); // before the send, not after
    expect(send).toMatch(/scheduleRecompose\(senderKey, toNumber, "stale-draft-recompose"\)/);
  });

  it("and the drain asks the SAME function, so the two cannot disagree", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/threadMovedOn\(\{/);
    // The duplicated inline copy of the reads is gone.
    expect(guard).not.toMatch(/judgeFreshness\(\{/);
  });
});

describe("a drop is never a dead end", () => {
  it("recomposing schedules a turn against what the shop just said", async () => {
    await scheduleRecompose("t@example.com", "66123456789", "stale-draft-recompose");
    const wakeup = inserted.find((i) => i.table === "graph_wakeups");
    expect(wakeup).toBeTruthy();
    expect(JSON.stringify(wakeup?.rows)).toMatch(/stale-draft-recompose/);
    expect(JSON.stringify(wakeup?.rows)).toMatch(/"kind":"tick"/);
  });
});

describe("what must NOT count as the shop changing its mind", () => {
  it("a burst the reply already coalesced does not throw that reply away", async () => {
    // Three messages in five seconds, all stored BEFORE we composed. The turn
    // answered all of them but is stamped with the id that triggered it.
    inbound = [
      { wa_message_id: "m-burst-3", received_at: "2026-07-31T05:22:50.000Z", body: "125cc ok?" },
      { wa_message_id: "m-burst-2", received_at: "2026-07-31T05:22:45.000Z", body: "180 baht" },
      { wa_message_id: "m-12-22", received_at: "2026-07-31T05:22:40.000Z", body: "hello" },
    ];
    expect((await threadMovedOn(draft)).stale).toBe(false);
  });

  it("a thumbs-up sticker does not cost the traveller a turn", async () => {
    // Contentless frames (stickers, reactions, edit/revoke) store an empty body.
    inbound = [
      { wa_message_id: "m-sticker", received_at: "2026-07-31T05:38:00.000Z", body: "" },
      { wa_message_id: "m-12-22", received_at: "2026-07-31T05:22:00.000Z", body: "180 baht" },
    ];
    expect((await threadMovedOn(draft)).stale).toBe(false);
  });

  it("...but real media does, because it carries a placeholder body", async () => {
    inbound = [
      { wa_message_id: "m-photo", received_at: "2026-07-31T05:38:00.000Z", body: "[photo]" },
      { wa_message_id: "m-12-22", received_at: "2026-07-31T05:22:00.000Z", body: "180 baht" },
    ];
    expect((await threadMovedOn(draft)).stale).toBe(true);
  });

  it("a cold introduction answers nothing and is never stale", async () => {
    inbound = [
      { wa_message_id: "m-new", received_at: "2026-07-31T05:38:00.000Z", body: "hi" },
    ];
    expect((await threadMovedOn({ ...draft, kind: "rfq" })).stale).toBe(false);
    expect((await threadMovedOn({ ...draft, kind: "custom" })).stale).toBe(false);
  });

  it("an unreadable thread sends rather than deletes", async () => {
    inbound = [];
    expect((await threadMovedOn(draft)).stale).toBe(false);
    expect((await threadMovedOn({ ...draft, composedAgainst: null })).stale).toBe(false);
  });
});

describe("a captionless video is not nothing", () => {
  it("REPRODUCTION: it is no longer discarded with no reply and no trace", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/function hasVideoMessage/);
    expect(ingest).toMatch(/if \(!syntheticText && hasVideo\) syntheticText = "\[video\]";/);
    // ...and the transcript shows it, like a photo or a voice note does.
    expect(ingest).toMatch(/hasVideo\s*\?\s*"\[video\]"/);
    expect(ingest).toMatch(/hasVideo\s*\?\s*"video"/);
  });
});
