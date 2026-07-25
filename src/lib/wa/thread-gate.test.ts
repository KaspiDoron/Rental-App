import { describe, it, expect } from "vitest";
import {
  classifyIngest,
  classifyIngestDetailed,
  isRfqAnchor,
  isDrillAnchor,
  DRILL_INGEST_WINDOW_MS,
  REAL_THREAD_INGEST_WINDOW_MS,
  type GateRaw,
} from "./thread-gate";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (raw: GateRaw | null, ageMs: number) => ({ received_at: ago(ageMs), raw });

describe("ingestion gate anchors", () => {
  it("recognises real RFQ anchors, rejects stray/human-manual", () => {
    expect(isRfqAnchor({ rfq: {} })).toBe(true);
    expect(isRfqAnchor({ vendorId: "abc123" })).toBe(true);
    expect(isRfqAnchor({ kind: "rfq" })).toBe(true);
    expect(isRfqAnchor({ kind: "human-manual" })).toBe(false);
    expect(isRfqAnchor({ kind: "session" })).toBe(false);
    expect(isRfqAnchor({ vendorId: "test-84912" })).toBe(false); // test id is not a real anchor
    expect(isRfqAnchor(null)).toBe(false);
  });

  it("recognises drill/test rehearsal anchors on either flag or id prefix", () => {
    expect(isDrillAnchor({ drill: true })).toBe(true);
    expect(isDrillAnchor({ test: true })).toBe(true);
    expect(isDrillAnchor({ vendorId: "drill-84912" })).toBe(true);
    expect(isDrillAnchor({ vendorId: "test-84912" })).toBe(true); // the outreach re-key case
    expect(isDrillAnchor({ vendorId: "realshop123" })).toBe(false);
  });
});

describe("classifyIngest - when is inbound ingestible", () => {
  it("no outbound history -> never ingest (personal contact you never messaged)", () => {
    expect(classifyIngest([], NOW)).toBe(false);
  });

  it("a real RFQ thread within the window is ingestible", () => {
    expect(classifyIngest([row({ rfq: {}, vendorId: "shop1" }, 60_000)], NOW)).toBe(true);
  });

  it("a real RFQ thread OLDER than the window retires (no silent re-open)", () => {
    expect(
      classifyIngest([row({ rfq: {}, vendorId: "shop1" }, REAL_THREAD_INGEST_WINDOW_MS + 3600_000)], NOW)
    ).toBe(false);
  });

  it("only stray / human-manual outbound (no RFQ anchor) -> NOT ingestible", () => {
    // A mistyped/personal number that only ever got a human-manual send must
    // never become a permanent ingestion target.
    expect(classifyIngest([row({ kind: "human-manual" }, 60_000)], NOW)).toBe(false);
  });

  it("finds the RFQ anchor a few messages back (newest may be human-manual)", () => {
    expect(
      classifyIngest(
        [row({ kind: "human-manual" }, 30_000), row({ rfq: {}, vendorId: "shop1" }, 120_000)],
        NOW
      )
    ).toBe(true);
  });

  it("drill/test thread: ingestible only inside the SHORT 3h window", () => {
    expect(classifyIngest([row({ drill: true, vendorId: "drill-1" }, 60 * 60_000)], NOW)).toBe(true); // 1h
    expect(
      classifyIngest([row({ drill: true, vendorId: "drill-1" }, DRILL_INGEST_WINDOW_MS + 60_000)], NOW)
    ).toBe(false); // just past 3h
  });

  it("a 'test-' re-keyed thread is WINDOWED, not a permanent target (the outreach hole)", () => {
    expect(classifyIngest([row({ vendorId: "test-84912", rfq: {} }, 60 * 60_000)], NOW)).toBe(true); // 1h ok
    expect(
      classifyIngest([row({ vendorId: "test-84912", rfq: {} }, DRILL_INGEST_WINDOW_MS + 60_000)], NOW)
    ).toBe(false); // past 3h - drill window wins even though rfq present
  });
});

describe("classifyIngestDetailed - the WA-doctor reason (ok matches classifyIngest)", () => {
  const cases: { name: string; rows: ReturnType<typeof row>[]; ok: boolean; reason: string }[] = [
    { name: "no outbound at all", rows: [], ok: false, reason: "no-outbound" },
    {
      name: "outbounds but no RFQ anchor",
      rows: [row({ kind: "human-manual" }, 60_000)],
      ok: false,
      reason: "no-rfq-anchor",
    },
    {
      name: "active RFQ thread inside window",
      rows: [row({ rfq: {}, vendorId: "shop1" }, 60 * 60_000)],
      ok: true,
      reason: "active-thread",
    },
    {
      name: "RFQ thread past the 14d window",
      rows: [row({ rfq: {}, vendorId: "shop1" }, REAL_THREAD_INGEST_WINDOW_MS + 60_000)],
      ok: false,
      reason: "thread-expired",
    },
    {
      name: "drill inside 3h window",
      rows: [row({ drill: true, vendorId: "drill-1" }, 60 * 60_000)],
      ok: true,
      reason: "drill-window-active",
    },
    {
      name: "drill past 3h window",
      rows: [row({ drill: true, vendorId: "drill-1" }, DRILL_INGEST_WINDOW_MS + 60_000)],
      ok: false,
      reason: "drill-expired",
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const d = classifyIngestDetailed(c.rows, NOW);
      expect(d.ok).toBe(c.ok);
      expect(d.reason).toBe(c.reason);
      // ok must always agree with the boolean gate
      expect(classifyIngest(c.rows, NOW)).toBe(c.ok);
    });
  }
});
