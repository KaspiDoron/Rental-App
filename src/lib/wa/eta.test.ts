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

  it("hour-scale holds get the wide upper bound - keyed on the REAL stored reasons", () => {
    // The old /hour|open/i regex missed "shop is closed now" entirely, so an
    // overnight park rendered as a tight ~5-minute window ("~05:38-05:44" on
    // a 10-hour wait). The pad now keys on the same classifier the labels
    // use, exercised here with the exact strings the guard writes.
    for (const reason of [
      "shop is closed now",
      "outside recipient business hours",
      "hourly cap reached (40/h at trust 20)",
      "daily cap reached (176/day) - resumes as capacity frees",
      "reply-rate circuit breaker (0% < 15%) - cold outreach frozen to protect the number",
      "delivery-rate breaker (40% delivered) - number may be soft-restricted",
      "number paused (ban-risk recovery)",
    ]) {
      const m = computeQueueEtas([row(1, NOW + 5000, "rfq", reason)], baseCtx());
      const w = m.get(1)!;
      expect(w.etaToMs - w.etaFromMs).toBeGreaterThanOrEqual(40 * 60_000);
    }
  });

  it("batch-spacing and pacing rows keep the tight pad", () => {
    for (const reason of ["batch-spacing", "human pacing gap", null]) {
      const m = computeQueueEtas([row(1, NOW + 5000, "rfq", reason)], baseCtx());
      const w = m.get(1)!;
      expect(w.etaToMs - w.etaFromMs).toBeLessThan(10 * 60_000);
    }
  });
});
