// Durable field KPIs (Module 7.1).
//
// The legacy analytics() (memory.ts) is in-memory and resets on restart. These
// KPIs compute from the durable tables so they survive redeploys and reflect the
// real fleet: discount margin (from offers), lead->booking conversion (bookings /
// searches), and human-escalation rate (takeover events / active threads). All
// bounded to a recent window and a row cap - cheap enough for an admin panel.
//
// Honest scope: response-latency p50/p95 needs a dedicated per-turn latency log
// (a fast-follow); it is deliberately not faked here. Token-cost efficiency and
// the telemetry safety score already exist (api/admin/costs, senderSafety).

import "server-only";
import { sbSelect } from "./runtime-config";

export interface OfferMargin {
  price_per_day: number | string | null;
  list_price_per_day: number | string | null;
}

/** Pure, testable: average realized discount % across offers (list -> paid). */
export function avgDiscountPct(offers: OfferMargin[]): { pct: number | null; sampled: number } {
  let sum = 0;
  let n = 0;
  for (const o of offers) {
    const list = Number(o.list_price_per_day);
    const paid = Number(o.price_per_day);
    if (list > 0 && paid > 0 && paid <= list) {
      sum += (list - paid) / list;
      n += 1;
    }
  }
  return { pct: n ? Number(((sum / n) * 100).toFixed(1)) : null, sampled: n };
}

export interface FieldKpis {
  discountMarginPct: number | null;
  offersSampled: number;
  conversionPct: number | null;
  searches30d: number;
  bookings30d: number;
  escalationPct: number | null;
  windowDays: number;
  note: string;
}

const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export async function fieldKpis(windowDays = 30): Promise<FieldKpis> {
  const since = sinceIso(windowDays);
  const [offers, searches, bookings, takeovers, threads] = await Promise.all([
    sbSelect<OfferMargin>(
      "offers",
      `select=price_per_day,list_price_per_day&created_at=gte.${since}&limit=10000`
    ).catch(() => []),
    sbSelect<{ id: number }>("searches", `select=id&created_at=gte.${since}&limit=10000`).catch(() => []),
    sbSelect<{ id: number }>("bookings", `select=id&created_at=gte.${since}&limit=10000`).catch(() => []),
    sbSelect<{ id: number }>(
      "agent_events",
      `select=id&kind=in.(human-takeover,takeover,takeover-detected)&created_at=gte.${since}&limit=10000`
    ).catch(() => []),
    sbSelect<{ id: number }>(
      "agent_events",
      `select=id&kind=eq.engine-v3-turn&created_at=gte.${since}&limit=20000`
    ).catch(() => []),
  ]);

  const { pct: discountMarginPct, sampled } = avgDiscountPct(offers);
  const conversionPct = searches.length
    ? Number(((bookings.length / searches.length) * 100).toFixed(1))
    : null;
  const escalationPct = threads.length
    ? Number(((takeovers.length / threads.length) * 100).toFixed(1))
    : null;

  return {
    discountMarginPct,
    offersSampled: sampled,
    conversionPct,
    searches30d: searches.length,
    bookings30d: bookings.length,
    escalationPct,
    windowDays,
    note: "Durable, last 30 days (sampled to 10k rows). Latency p50/p95 is a fast-follow (needs a per-turn latency log).",
  };
}
