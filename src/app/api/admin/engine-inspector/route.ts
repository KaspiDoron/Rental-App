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
  // Newest stamp so the client can be HONEST that "open" is a durable mirror
  // (it never downgrades on a real socket loss), not a live-liveness claim.
  const socketsStampedAt = sessions[0]?.updated_at ?? null;

  // ---- Webhook liveness: recent inbound + accept/403 breadcrumbs -------------
  // BUG FIX: whatsapp_messages has NO `created_at` column - the timestamp is
  // `received_at`. The old query filtered/ordered on created_at, PostgREST
  // 400'd, sbSelect swallowed it, and LAST INBOUND was permanently "-".
  const inbound = await sbSelect<{ from_number: string; received_at: string }>(
    "whatsapp_messages",
    `select=from_number,received_at&direction=eq.inbound&received_at=gte.${encodeURIComponent(
      new Date(now - 6 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=1`
  ).catch(() => []);
  const webhookEvents = await sbSelect<{ kind: string; created_at: string }>(
    "agent_events",
    `select=kind,created_at&kind=in.(webhook-ok,webhook-403)&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&order=created_at.desc&limit=20`
  ).catch(() => []);
  const lastAcceptedAt = webhookEvents.find((e) => e.kind === "webhook-ok")?.created_at ?? null;
  const last403At = webhookEvents.find((e) => e.kind === "webhook-403")?.created_at ?? null;

  // ---- REAL 6h turn count (the tile used turns.length, capped at 30) ---------
  const TURN_COUNT_CAP = 1000;
  const turnCountRows = await sbSelect<{ id: number }>(
    "agent_events",
    `select=id&kind=eq.engine-v3-turn&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&limit=${TURN_COUNT_CAP}`
  ).catch(() => []);
  const turnsLast6h = turnCountRows.length;

  return NextResponse.json({
    engine: "ENGINE_V3 (SPTE - Shared Session Blackboard + Single-Pass)",
    generatedAt: new Date(now).toISOString(),
    turns,
    stats: {
      turnsLast6h, // real count (may show "1000+" at the cap), not turns.length
      turnsCapped: turnsLast6h >= TURN_COUNT_CAP,
      failoversLast6h: fallbacks,
      unconfirmedSendsLast6h: unconfirmed,
    },
    session: {
      lowestByVehicle: [...lowestByVehicle.entries()].map(([k, v]) => ({ key: k, ...v })).slice(0, 12),
      activeOffers: offers.length,
    },
    queue: { depth: queue.length, dueNow, nextAt },
    sockets: { live: liveSockets, total: sessions.length, stampedAt: socketsStampedAt },
    webhook: { lastInboundAt: inbound[0]?.received_at ?? null, lastAcceptedAt, last403At },
  });
}
