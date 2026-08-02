import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import {
  buildPeeks,
  firstByVendor,
  newestInboundByLine,
  safeVendorIds,
  MAX_PEEK_VENDORS,
  type PeekInRow,
  type PeekOutRow,
  type PeekQueuedRow,
} from "./peek-batch";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// TWENTY CARDS, TWENTY POLLS, SIXTY QUERIES A TICK.
//
// ThreadPeek is mounted once per engaged shop and owned its own interval and
// its own fetch, so the poll count scaled with the board. The answer for twenty
// shops is the same two reads as the answer for one - only the grouping is
// different, and the grouping is where it can go silently wrong.

const out = (vendorId: string, to: string, body: string, at: string): PeekOutRow => ({
  body,
  received_at: at,
  to_number: to,
  raw: { vendorId },
});

const inbound = (from: string, body: string, at: string): PeekInRow => ({
  body,
  received_at: at,
  from_number: from,
  raw: null,
});

describe("the vendor id list is a filter, not an escape", () => {
  it("keeps real ids and drops anything that could break the query grammar", () => {
    expect(safeVendorIds("ChIJabc-123,shop_9:2")).toEqual(["ChIJabc-123", "shop_9:2"]);
    expect(safeVendorIds('a,"),b')).toEqual(["a", "b"]);
    expect(safeVendorIds("a,(select),b")).toEqual(["a", "b"]);
    expect(safeVendorIds("a, a ,a")).toEqual(["a"]);
  });

  it("is bounded - one request cannot ask for thousands of shops", () => {
    const many = Array.from({ length: 500 }, (_, i) => `v${i}`).join(",");
    expect(safeVendorIds(many)).toHaveLength(MAX_PEEK_VENDORS);
  });

  it("survives empty and junk input without throwing", () => {
    expect(safeVendorIds("")).toEqual([]);
    expect(safeVendorIds(",,, ,")).toEqual([]);
    expect(safeVendorIds("x".repeat(200))).toEqual([]);
  });
});

describe("grouping: the newest row per shop out of one descending read", () => {
  it("takes the first row it sees for each vendor and ignores the rest", () => {
    const rows = [
      out("A", "66811111111", "newest to A", "2026-08-01T12:00:00Z"),
      out("B", "66822222222", "newest to B", "2026-08-01T11:00:00Z"),
      out("A", "66811111111", "older to A", "2026-08-01T09:00:00Z"),
    ];
    const map = firstByVendor(rows, (r) => r.raw?.vendorId);
    expect(map.get("A")?.body).toBe("newest to A");
    expect(map.get("B")?.body).toBe("newest to B");
    expect(map.size).toBe(2);
  });

  it("a row with no vendorId is skipped, never bucketed under undefined", () => {
    // Annotated: `raw: null` narrowed the element to `never`, so `r.raw?.vendorId`
    // was not type-checkable - and the assertion was testing nothing about the
    // real row shape.
    const rows: Array<ReturnType<typeof out> & { raw: { vendorId?: string } | null }> = [
      { ...out("", "6681", "x", "2026-08-01T12:00:00Z"), raw: null },
    ];
    expect(firstByVendor(rows, (r) => r.raw?.vendorId).size).toBe(0);
  });
});

describe("REPRODUCTION: the in-memory join is by LINE, not by number string", () => {
  it("an inbound reply finds its thread across a spelling difference", () => {
    // Discovery stored the national number Google published; WhatsApp delivered
    // the international one. Keying a Map on the raw string is the exact bug
    // identityKey exists to prevent - and here it would fail SILENTLY, because
    // an unmatched peek looks identical to a shop that has not replied.
    const outs = [out("A", "0966 195 2196".replace(/\D/g, ""), "we sent this", "2026-08-01T10:00:00Z")];
    const ins = [inbound("639661952196", "600 per day", "2026-08-01T10:05:00Z")];
    const peeks = buildPeeks(["A"], outs, ins, []);
    expect(peeks.A.received?.text).toBe("600 per day");
  });

  it("...and a DIFFERENT shop's reply is never attached to this card", () => {
    const outs = [out("A", "639661952196", "we sent this", "2026-08-01T10:00:00Z")];
    const ins = [inbound("66812345678", "another shop entirely", "2026-08-01T10:05:00Z")];
    const peeks = buildPeeks(["A"], outs, ins, []);
    expect(peeks.A.received).toBeNull();
  });

  it("only the NEWEST reply per line survives", () => {
    const ins = [
      inbound("639661952196", "newest", "2026-08-01T12:00:00Z"),
      inbound("639661952196", "older", "2026-08-01T09:00:00Z"),
    ];
    expect(newestInboundByLine(ins).size).toBe(1);
    expect(
      buildPeeks(["A"], [out("A", "639661952196", "sent", "2026-08-01T08:00:00Z")], ins, []).A
        .received?.text
    ).toBe("newest");
  });
});

describe("the batched answer matches what a single-vendor read would have said", () => {
  it("a delivered message wins over a queued one", () => {
    const outs = [out("A", "639661952196", "delivered", "2026-08-01T10:00:00Z")];
    const queued: PeekQueuedRow[] = [
      { body: "still waiting", not_before: "2026-08-01T11:00:00Z", meta: { vendorId: "A" } },
    ];
    const peeks = buildPeeks(["A"], outs, [], queued);
    expect(peeks.A.sent?.text).toBe("delivered");
    expect(peeks.A.sent?.queued).toBeUndefined();
  });

  it("nothing delivered yet shows the QUEUED body, flagged as queued", () => {
    // The card never shows a client-side draft and never claims "sent" for a
    // message the guard is still holding.
    const queued: PeekQueuedRow[] = [
      {
        body: "hi, do you have a 125 available",
        not_before: "2026-08-01T11:00:00Z",
        meta: { vendorId: "A", englishGloss: "gloss" },
      },
    ];
    const peeks = buildPeeks(["A"], [], [], queued);
    expect(peeks.A.sent).toEqual({
      text: "hi, do you have a 125 available",
      at: "2026-08-01T11:00:00Z",
      english: "gloss",
      queued: true,
    });
  });

  it("the queued row chosen is the one that goes out NEXT", () => {
    const queued: PeekQueuedRow[] = [
      { body: "first out", not_before: "2026-08-01T10:00:00Z", meta: { vendorId: "A" } },
      { body: "later", not_before: "2026-08-01T18:00:00Z", meta: { vendorId: "A" } },
    ];
    expect(buildPeeks(["A"], [], [], queued).A.sent?.text).toBe("first out");
  });

  it("every requested shop gets an entry, including one with no thread at all", () => {
    // The client must be able to tell "no conversation yet" from "this tick did
    // not cover you".
    const peeks = buildPeeks(["A", "B"], [], [], []);
    expect(Object.keys(peeks).sort()).toEqual(["A", "B"]);
    expect(peeks.B).toEqual({ sent: null, received: null });
  });

  it("the English gloss survives the batch on both sides", () => {
    const outs: PeekOutRow[] = [
      {
        body: "สวัสดีครับ",
        received_at: "2026-08-01T10:00:00Z",
        to_number: "66812345678",
        raw: { vendorId: "A", englishGloss: "hello" },
      },
    ];
    const ins: PeekInRow[] = [
      {
        body: "500 บาท",
        received_at: "2026-08-01T10:05:00Z",
        from_number: "66812345678",
        raw: { english: "500 baht" },
      },
    ];
    const peeks = buildPeeks(["A"], outs, ins, []);
    expect(peeks.A.sent?.english).toBe("hello");
    expect(peeks.A.received?.english).toBe("500 baht");
  });
});

describe("the wiring: one timer and one request for the whole board", () => {
  const store = readCode("src/lib/client/thread-peek-store.ts");
  const peek = readCode("src/components/ThreadPeek.tsx");
  const route = readCode("src/app/api/thread/route.ts");

  it("REPRODUCTION: the per-card interval and fetch are gone", () => {
    expect(peek).not.toMatch(/setInterval/);
    expect(peek).not.toMatch(/fetch\(/);
    expect(peek).toMatch(/return subscribeThreadPeek\(vendorId, since, \(peek\) => \{/);
  });

  it("the store polls once, for every subscribed shop at once", () => {
    expect(store).toMatch(/timer = setInterval\(\(\) => void tick\(\), PEEK_POLL_MS\);/);
    expect(store).toMatch(/const ids = \[\.\.\.subscribers\.keys\(\)\];/);
    expect(store).toMatch(/\/api\/thread\?vendorIds=/);
  });

  it("a mount storm collapses into ONE request, not one per card", () => {
    expect(store).toMatch(/const COALESCE_MS = \d+;/);
    expect(store).toMatch(/if \(coalesce\) return;/);
  });

  it("a slow answer cannot be overtaken and painted out of order", () => {
    expect(store).toMatch(/if \(inFlight\) return;/);
    expect(store).toMatch(/signal: ac\.signal/);
  });

  it("a hidden tab costs nothing, and coming back refreshes immediately", () => {
    expect(store).toMatch(/if \(typeof document !== "undefined" && document\.hidden\) return;/);
    expect(store).toMatch(/document\.addEventListener\("visibilitychange", onVisibility\);/);
    expect(store).toMatch(/document\.removeEventListener\("visibilitychange", onVisibility\);/);
  });

  it("a new search invalidates the cache - no previous session bleed", () => {
    expect(store).toMatch(/if \(sessionEpoch\) cache\.clear\(\);/);
  });

  it("the route keeps BOTH privacy scopes in batch mode", () => {
    // Batching changes how many queries run, never whose messages they see.
    expect(route).toMatch(/direction=eq\.outbound&raw->>sender=eq\.\$\{who\}/);
    expect(route).toMatch(/direction=eq\.inbound&raw->>receiver=eq\.\$\{who\}/);
  });

  it("...and skips the queued read entirely once every card has a real message", () => {
    expect(route).toMatch(/const waiting = ids\.filter\(\(id\) => !delivered\.has\(id\)\);/);
    expect(route).toMatch(/const queued = waiting\.length/);
  });
});
