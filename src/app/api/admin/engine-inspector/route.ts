import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// SESSION BLACKBOARD INSPECTOR (owner-only). A single live snapshot of the
// ENGINE_V3 (SPTE) runtime: recent single-pass turns with their move + model
// route + scratchpad, any graph-engine failovers, the outbound queue health, WA
// socket liveness, and the most recent inbound webhook confirmations. Everything
// degrades gracefully - a missing table yields an empty section, never a 500.

export const dynamic = "force-dynamic";

type EventRow = { kind: string; vendor_name?: string | null; detail?: string | null; created_at?: string };

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sinceIso = new Date(Date.now() - 6 * 3600_000).toISOString();

  // ---- ENGINE_V3 turns + failovers (the ReAct execution telemetry) ----------
  const events = await sbSelect<EventRow>(
    "agent_events",
    `select=kind,vendor_name,detail,created_at&kind=in.(engine-v3-turn,engine-v3-fallback,wa-send-unconfirmed)&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=60`
  ).catch(() => [] as EventRow[]);

  const turns = events
    .filter((e) => e.kind === "engine-v3-turn")
    .map((e) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(e.detail ?? "{}");
      } catch {
        /* keep empty */
      }
      return { shop: e.vendor_name ?? "shop", at: e.created_at, ...d };
    })
    .slice(0, 30);

  const fallbacks = events.filter((e) => e.kind === "engine-v3-fallback").length;
  const unconfirmed = events.filter((e) => e.kind === "wa-send-unconfirmed").length;

  // ---- Global session state: lowest offer + rivals per active search --------
  const offers = await sbSelect<{
    vendor_name: string;
    price_per_day: number;
    currency: string;
    vehicle_key: string | null;
    created_at: string;
  }>(
    "offers",
    `select=vendor_name,price_per_day,currency,vehicle_key,created_at&simulated=eq.false&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=price_per_day.asc&limit=40`
  ).catch(() => []);

  const lowestByVehicle = new Map<string, { shop: string; pricePerDay: number; currency: string }>();
  for (const o of offers) {
    const key = `${o.vehicle_key ?? "?"}:${o.currency}`;
    if (!lowestByVehicle.has(key)) {
      lowestByVehicle.set(key, { shop: o.vendor_name, pricePerDay: o.price_per_day, currency: o.currency });
    }
  }

  // ---- Queue health: outbox depth + how far ahead the next send is ----------
  const queue = await sbSelect<{ id: number; not_before: string; meta: { kind?: string } | null }>(
    "wa_outbox",
    `select=id,not_before,meta&order=not_before.asc&limit=200`
  ).catch(() => []);
  const now = Date.now();
  const dueNow = queue.filter((q) => Date.parse(q.not_before) <= now).length;
  const nextAt = queue[0]?.not_before ?? null;

  // ---- WA socket liveness (sessions marked open) ----------------------------
  const sessions = await sbSelect<{ email: string; status?: string | null; updated_at?: string }>(
    "wa_sessions",
    `select=email,status,updated_at&order=updated_at.desc&limit=50`
  ).catch(() => []);
  const liveSockets = sessions.filter((s) => String(s.status ?? "").toLowerCase() === "open").length;

  // ---- Webhook delivery confirmations: recent inbound ------------------------
  const inbound = await sbSelect<{ from_number: string; created_at: string }>(
    "whatsapp_messages",
    `select=from_number,created_at&direction=eq.inbound&created_at=gte.${encodeURIComponent(
      new Date(now - 3600_000).toISOString()
    )}&order=created_at.desc&limit=1`
  ).catch(() => []);

  return NextResponse.json({
    engine: "ENGINE_V3 (SPTE - Shared Session Blackboard + Single-Pass)",
    generatedAt: new Date(now).toISOString(),
    turns,
    stats: {
      turnsLast6h: turns.length,
      failoversLast6h: fallbacks,
      unconfirmedSendsLast6h: unconfirmed,
    },
    session: {
      lowestByVehicle: [...lowestByVehicle.entries()].map(([k, v]) => ({ key: k, ...v })).slice(0, 12),
      activeOffers: offers.length,
    },
    queue: { depth: queue.length, dueNow, nextAt },
    sockets: { live: liveSockets, total: sessions.length },
    webhook: { lastInboundAt: inbound[0]?.created_at ?? null },
  });
}
