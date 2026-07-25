import { describe, it, expect } from "vitest";
import { computeQueueEtas, type EtaRow, type EtaContext } from "./eta";

const NOW = 1_000_000_000_000;
const baseCtx = (over: Partial<EtaContext> = {}): EtaContext => ({
  nowMs: NOW,
  lastSendAtMs: null,
  minGapSec: 12,
  gapJitterSec: 16,
  stealth: 1,
  introRemaining: 10,
  introNextFreeAtMs: null,
  coldPerDrain: 2,
  drainCadenceMs: 60_000,
  ...over,
});
const row = (id: number, notBeforeMs: number, kind: string | null = "rfq", rawReason: string | null = null): EtaRow => ({
  id,
  notBeforeMs,
  kind,
  rawReason,
});

describe("computeQueueEtas - honest envelope", () => {
  it("etaTo >= etaFrom >= now for every row", () => {
    const rows = [row(1, NOW - 5000), row(2, NOW + 30_000), row(3, NOW + 90_000)];
    const m = computeQueueEtas(rows, baseCtx());
    for (const r of rows) {
      const w = m.get(r.id)!;
      expect(w.etaFromMs).toBeGreaterThanOrEqual(NOW);
      expect(w.etaToMs).toBeGreaterThanOrEqual(w.etaFromMs);
    }
  });

  it("is position-monotonic - later rows never resolve before earlier ones", () => {
    const rows = [row(1, NOW), row(2, NOW), row(3, NOW), row(4, NOW)];
    const m = computeQueueEtas(rows, baseCtx());
    const froms = [1, 2, 3, 4].map((id) => m.get(id)!.etaFromMs);
    for (let i = 1; i < froms.length; i++) expect(froms[i]).toBeGreaterThanOrEqual(froms[i - 1]);
  });

  it("flags overdue when not_before is in the past, but never returns a past ETA", () => {
    const m = computeQueueEtas([row(1, NOW - 120_000)], baseCtx());
    const w = m.get(1)!;
    expect(w.overdue).toBe(true);
    expect(w.etaFromMs).toBeGreaterThanOrEqual(NOW);
  });

  it("respects the last-send min-gap (x stealth) before the first send", () => {
    const m = computeQueueEtas([row(1, NOW)], baseCtx({ lastSendAtMs: NOW - 3000, stealth: 2, minGapSec: 12 }));
    // gap = 12s * 2 = 24s; last send 3s ago -> ~21s more from now
    expect(m.get(1)!.etaFromMs).toBe(NOW - 3000 + 24_000);
  });

  it("cold rows beyond the intro budget wait for nextFreeAt", () => {
    const nextFree = NOW + 10 * 60_000;
    const rows = [row(1, NOW), row(2, NOW), row(3, NOW)];
    const m = computeQueueEtas(rows, baseCtx({ introRemaining: 2, introNextFreeAtMs: nextFree }));
    // rows 1,2 fit the budget; row 3 (3rd cold) must not be earlier than nextFree
    expect(m.get(3)!.etaFromMs).toBeGreaterThanOrEqual(nextFree);
  });

  it("is deterministic", () => {
    const rows = [row(1, NOW), row(2, NOW + 5000)];
    expect(computeQueueEtas(rows, baseCtx())).toEqual(computeQueueEtas(rows, baseCtx()));
  });

  it("a business-hours-held row gets the wide upper bound", () => {
    const m = computeQueueEtas([row(1, NOW + 5000, "rfq", "held for opening hours")], baseCtx());
    const w = m.get(1)!;
    // etaTo includes the ~40 min business-hours pad
    expect(w.etaToMs - w.etaFromMs).toBeGreaterThanOrEqual(40 * 60_000);
  });
});
