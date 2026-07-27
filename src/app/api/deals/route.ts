import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { toTrip } from "@/lib/trips";

export const dynamic = "force-dynamic";

// The "My deals" hub, rebuilt around SEARCH SESSIONS instead of a flat offer
// list. A session is a living object: who was contacted, who answered, who is
// still quiet, the best price on the table, how far the negotiation got, what
// Will plans next and what needs the traveller's attention. Everything is
// derived from data the pipeline already persists - this endpoint only reads,
// strictly scoped to the signed-in user.
//
// Session boundaries: `searches` rows are grouped into one session while they
// land within 30 minutes of the previous row (the profiler row + the vendor
// discovery row + radius tweaks all merge). Each session owns the activity
// window from its first row until the next session starts.

interface SearchRow {
  id: number;
  query_text: string | null;
  radius_km: number | null;
  vehicle_class: string | null;
  source: string | null;
  results: number | null;
  created_at: string;
}

interface OfferRow {
  id: number;
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  list_price_per_day?: number | null;
  currency: string | null;
  round: number | null;
  verified: boolean | null;
  created_at: string;
}

interface BookingRow {
  id: number;
  vendor_name: string | null;
  price_per_day: number | null;
  total_price: number | null;
  currency: string | null;
  fulfillment: string | null;
  scheduled_at: string | null;
  status: string | null;
  created_at: string;
}

export interface SessionOffer {
  vendorId: string;
  vendorName: string;
  current: number;
  ask: number | null; // list/first quote - the honest "before" number
  currency: string;
  round: number;
  verified: boolean;
  at: string;
  stale: boolean;
}

export interface TimelineEvent {
  at: string;
  kind: "sent" | "reply" | "offer" | "alert" | "booked" | "you";
  vendorName?: string;
  text: string;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  isLatest: boolean;
  query: string | null;
  vehicleClass: string | null;
  radiusKm: number | null;
  shopsFound: number;
  status: "booked" | "live" | "waiting" | "wrapped";
  paused: boolean;
  contacted: number;
  replied: number;
  waiting: number;
  offers: SessionOffer[];
  best: (SessionOffer & { savedPct: number | null }) | null;
  avgAsk: number | null; // average asking price across shops (dominant currency)
  booking: {
    vendorName: string;
    total: number | null;
    perDay: number | null;
    currency: string;
    scheduledAt: string | null;
    at: string;
  } | null;
  attention: string[];
  plannedMoves: { at: string; vendorName: string | null; reason: string }[];
  queuedSends: number;
  timeline: TimelineEvent[];
  progress: number; // 0..100
  progressLabel: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_GAP_MS = 30 * 60 * 1000;

function progressFor(s: {
  booked: boolean;
  bestVerified: boolean;
  anyCounter: boolean;
  anyOffer: boolean;
  replied: number;
  contacted: number;
}): { progress: number; label: string } {
  if (s.booked) return { progress: 100, label: "Deal locked in" };
  if (s.bestVerified) return { progress: 85, label: "Best price confirmed - ready when you are" };
  if (s.anyCounter) return { progress: 70, label: "Counter-offers in play" };
  if (s.anyOffer) return { progress: 55, label: "First quotes are in" };
  if (s.replied > 0) return { progress: 40, label: "Shops are answering" };
  if (s.contacted > 0) return { progress: 20, label: "Openers sent - replies usually take a bit" };
  return { progress: 10, label: "Setting up the hunt" };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const email = session.email;
  const enc = encodeURIComponent(email);

  // 1. Recent search rows -> session groups (newest 14 days keeps it fast).
  const sinceIso = new Date(Date.now() - 14 * DAY_MS).toISOString();
  const searchRows = await sbSelect<SearchRow>(
    "searches",
    `select=id,query_text,radius_km,vehicle_class,source,results,created_at&user_email=eq.${enc}&created_at=gte.${sinceIso}&order=created_at.desc&limit=30`
  ).catch(() => [] as SearchRow[]);

  const asc = [...searchRows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const groups: SearchRow[][] = [];
  for (const row of asc) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Date.parse(row.created_at) - Date.parse(last[last.length - 1].created_at) <= GROUP_GAP_MS
    ) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }
  // Newest session first; keep the dashboard focused on the last few hunts.
  groups.reverse();
  const kept = groups.slice(0, 5);

  const oldestStart = kept.length
    ? kept[kept.length - 1][0].created_at
    : new Date(Date.now() - DAY_MS).toISOString();

  // 2. Everything the pipeline persisted since the oldest kept session.
  const [outbound, replies, offers, bookings, riskEvents, outbox, wakeups, pauseMarkers] =
    await Promise.all([
      sbSelect<{
        id: number;
        to_number: string;
        body: string | null;
        raw: { vendorId?: string; vendorName?: string; english?: string; kind?: string } | null;
        received_at: string;
      }>(
        "whatsapp_messages",
        `select=id,to_number,body,raw,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${oldestStart}&order=received_at.desc&limit=250`
      ).catch(() => []),
      sbSelect<{
        id: number;
        vendor_id: string | null;
        vendor_name: string | null;
        reply_text: string | null;
        image_count: number | null;
        created_at: string;
      }>(
        "vendor_replies",
        `select=id,vendor_id,vendor_name,reply_text,image_count,created_at&user_email=eq.${enc}&created_at=gte.${oldestStart}&order=created_at.desc&limit=250`
      ).catch(() => []),
      (async () => {
        let rows = await sbSelect<OfferRow>(
          "offers",
          `select=id,vendor_id,vendor_name,price_per_day,list_price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${oldestStart}&order=created_at.desc&limit=250`
        );
        if (rows.length === 0) {
          rows = await sbSelect<OfferRow>(
            "offers",
            `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${oldestStart}&order=created_at.desc&limit=250`
          );
        }
        return rows;
      })().catch(() => [] as OfferRow[]),
      sbSelect<BookingRow>(
        "bookings",
        `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&user_email=eq.${enc}&order=created_at.desc&limit=25`
      ).catch(() => [] as BookingRow[]),
      sbSelect<{
        id: number;
        vendor_name: string | null;
        detail: string | null;
        created_at: string;
      }>(
        "agent_events",
        // Exact ownership match (the LIKE substring filter leaked alerts
        // across users whose emails were substrings of each other).
        `select=id,vendor_name,detail,created_at&kind=eq.inbound-risk&user_email=eq.${encodeURIComponent(
          email
        )}&created_at=gte.${oldestStart}&order=created_at.desc&limit=20`
      ).catch(() => []),
      sbSelect<{ id: number; not_before: string }>(
        "wa_outbox",
        `select=id,not_before&sender_key=eq.${enc}&order=not_before.asc&limit=50`
      ).catch(() => []),
      sbSelect<{
        id: number;
        not_before: string;
        payload: { reason?: string; vendorName?: string } | null;
      }>(
        "graph_wakeups",
        // EXACT ownership match on the stamped column - the old
        // `thread_key=like.<email>:*` read could surface a DIFFERENT user's
        // wakeup (shop name + reason) when one email was a `_`-wildcard match
        // of another. Unstamped legacy rows are hidden by design (same
        // precedent as the agent_events feed filter).
        `select=id,not_before,payload&user_email=eq.${encodeURIComponent(
          email
        )}&kind=eq.tick&order=not_before.asc&limit=10`
      ).catch(() => []),
      sbSelect<{ raw: { kind?: string } | null }>(
        "whatsapp_messages",
        `select=raw&to_number=eq.session&raw->>sender=eq.${enc}&order=received_at.desc&limit=1`
      ).catch(() => []),
    ]);

  const now = Date.now();
  const paused = pauseMarkers[0]?.raw?.kind === "session-paused";

  // 3. Build each session's living summary from its activity window.
  const sessions: SessionSummary[] = kept.map((group, gi) => {
    const start = Date.parse(group[0].created_at);
    // The next-newer session's start closes this window.
    const end = gi === 0 ? Infinity : Date.parse(kept[gi - 1][0].created_at);
    const inWindow = (iso: string) => {
      const t = Date.parse(iso);
      return t >= start && t < end;
    };
    const isLatest = gi === 0;

    const query = group.find((r) => r.query_text)?.query_text ?? null;
    const vehicleClass = [...group].reverse().find((r) => r.vehicle_class)?.vehicle_class ?? null;
    const radiusKm = [...group].reverse().find((r) => r.radius_km != null)?.radius_km ?? null;
    const shopsFound = Math.max(0, ...group.map((r) => r.results ?? 0));

    const sent = outbound.filter((m) => inWindow(m.received_at));
    const humanSent = sent.filter((m) => m.raw?.kind === "human-manual");
    const rep = replies.filter((r) => inWindow(r.created_at));
    const off = offers.filter((o) => inWindow(o.created_at) && (o.price_per_day ?? 0) > 0);
    const risks = riskEvents.filter((e) => inWindow(e.created_at));
    const booking = bookings.find((b) => inWindow(b.created_at)) ?? null;

    const contactedIds = new Set<string>();
    for (const m of sent) contactedIds.add(m.raw?.vendorId || m.to_number);
    const repliedIds = new Set<string>();
    for (const r of rep) repliedIds.add(r.vendor_id || r.vendor_name || String(r.id));
    const contacted = contactedIds.size;
    const replied = Math.min(repliedIds.size, contacted || repliedIds.size);

    // Per-vendor: newest price + the honest "before" number (list price when
    // the shop stated one, otherwise the earliest quote in this session).
    const byVendor = new Map<string, { newest: OfferRow; earliest: OfferRow; ask: number | null }>();
    for (const o of off) {
      const key = o.vendor_id || o.vendor_name || String(o.id);
      const cur = byVendor.get(key);
      if (!cur) {
        byVendor.set(key, { newest: o, earliest: o, ask: o.list_price_per_day ?? null });
      } else {
        // offers arrive desc: first seen is newest, keep updating earliest.
        cur.earliest = o;
        if (o.list_price_per_day && !cur.ask) cur.ask = o.list_price_per_day;
      }
    }

    const sessionOffers: SessionOffer[] = [...byVendor.entries()].map(([key, v]) => {
      const ask = v.ask ?? (v.earliest.id !== v.newest.id ? v.earliest.price_per_day : null);
      return {
        vendorId: v.newest.vendor_id ?? key,
        vendorName: v.newest.vendor_name ?? "Rental shop",
        current: Number(v.newest.price_per_day),
        ask: ask != null && Number(ask) > Number(v.newest.price_per_day) ? Number(ask) : null,
        currency: v.newest.currency ?? "USD",
        round: v.newest.round ?? 0,
        verified: Boolean(v.newest.verified),
        at: v.newest.created_at,
        stale: now - Date.parse(v.newest.created_at) > DAY_MS,
      };
    });

    // Dominant currency keeps comparisons honest across mixed quotes.
    const curCount = new Map<string, number>();
    for (const o of sessionOffers) curCount.set(o.currency, (curCount.get(o.currency) ?? 0) + 1);
    const domCurrency =
      [...curCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const comparable = sessionOffers.filter((o) => o.currency === domCurrency);
    comparable.sort((a, b) => a.current - b.current || Number(b.verified) - Number(a.verified));
    const bestRaw = comparable[0] ?? null;
    const asks = comparable.map((o) => o.ask).filter((a): a is number => a != null && a > 0);
    const avgAsk = asks.length
      ? Math.round((asks.reduce((s, a) => s + a, 0) / asks.length) * 100) / 100
      : null;
    const best = bestRaw
      ? {
          ...bestRaw,
          savedPct:
            bestRaw.ask && bestRaw.ask > bestRaw.current
              ? Math.round(((bestRaw.ask - bestRaw.current) / bestRaw.ask) * 100)
              : null,
        }
      : null;

    // What needs the traveller (not the agent) right now.
    const attention: string[] = [];
    if (isLatest && paused) attention.push("Search is paused - Will is holding all messages until you resume.");
    for (const e of risks.slice(0, 3)) {
      let reason = "a reply worth a second look";
      try {
        const d = JSON.parse(e.detail ?? "{}");
        if (Array.isArray(d.reasons) && d.reasons[0]) reason = String(d.reasons[0]);
      } catch {}
      attention.push(`${e.vendor_name ?? "A shop"}: ${reason}`);
    }
    if (!booking && best?.stale) {
      attention.push("The best quote is over a day old - worth re-confirming before you rely on it.");
    }

    const plannedMoves = isLatest
      ? wakeups
          .filter((w) => Date.parse(w.not_before) > now)
          .slice(0, 3)
          .map((w) => ({
            at: w.not_before,
            vendorName: w.payload?.vendorName ?? null,
            reason:
              w.payload?.reason ??
              "waiting a moment so the shop takes the offer seriously",
          }))
      : [];
    const queuedSends = isLatest ? outbox.length : 0;

    // Compact timeline: the last few moments that actually matter.
    const timeline: TimelineEvent[] = [];
    for (const m of sent.slice(0, 12)) {
      timeline.push({
        at: m.received_at,
        kind: m.raw?.kind === "human-manual" ? "you" : "sent",
        vendorName: m.raw?.vendorName,
        text:
          m.raw?.kind === "human-manual"
            ? "You messaged the shop yourself"
            : (m.raw?.english || m.body || "Message sent").slice(0, 90),
      });
    }
    for (const r of rep.slice(0, 12)) {
      timeline.push({
        at: r.created_at,
        kind: "reply",
        vendorName: r.vendor_name ?? undefined,
        text: (r.reply_text ?? (r.image_count ? "Sent a photo" : "Replied")).slice(0, 90),
      });
    }
    for (const o of off.slice(0, 12)) {
      timeline.push({
        at: o.created_at,
        kind: "offer",
        vendorName: o.vendor_name ?? undefined,
        text: `${o.verified ? "Confirmed" : "Quoted"} ${o.price_per_day} ${o.currency ?? ""}/day${
          (o.round ?? 0) > 0 ? ` after round ${o.round}` : ""
        }`,
      });
    }
    for (const e of risks.slice(0, 3)) {
      timeline.push({
        at: e.created_at,
        kind: "alert",
        vendorName: e.vendor_name ?? undefined,
        text: "Will flagged this reply for you",
      });
    }
    if (booking) {
      timeline.push({
        at: booking.created_at,
        kind: "booked",
        vendorName: booking.vendor_name ?? undefined,
        text: "Deal locked in",
      });
    }
    timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const lastEventAt = timeline[0] ? Date.parse(timeline[0].at) : start;
    const anyCounter = sessionOffers.some((o) => o.round > 0);
    const { progress, label } = progressFor({
      booked: Boolean(booking),
      bestVerified: Boolean(best?.verified),
      anyCounter,
      anyOffer: sessionOffers.length > 0,
      replied,
      contacted,
    });

    const status: SessionSummary["status"] = booking
      ? "booked"
      : (isLatest && (queuedSends > 0 || plannedMoves.length > 0)) || now - lastEventAt < 45 * 60 * 1000
        ? "live"
        : replied < contacted && now - start < 2 * DAY_MS
          ? "waiting"
          : "wrapped";

    return {
      id: String(group[0].id),
      startedAt: group[0].created_at,
      isLatest,
      query,
      vehicleClass,
      radiusKm: radiusKm != null ? Number(radiusKm) : null,
      shopsFound,
      status,
      paused: isLatest ? paused : false,
      contacted: Math.max(contacted, humanSent.length ? 1 : 0),
      replied,
      waiting: Math.max(0, contacted - replied),
      offers: sessionOffers.sort((a, b) => a.current - b.current).slice(0, 12),
      best,
      avgAsk,
      booking: booking
        ? {
            vendorName: booking.vendor_name ?? "Rental shop",
            total: booking.total_price != null ? Number(booking.total_price) : null,
            perDay: booking.price_per_day != null ? Number(booking.price_per_day) : null,
            currency: booking.currency ?? "USD",
            scheduledAt: booking.scheduled_at,
            at: booking.created_at,
          }
        : null,
      attention,
      plannedMoves,
      queuedSends,
      timeline: timeline.slice(0, 6),
      progress,
      progressLabel: label,
      // THE TRIP: what became of this hunt, what it cost, what it saved.
      // A session could only ever describe what is happening right now, so a
      // finished hunt looked exactly like an abandoned one and a traveller who
      // actually rented something had nothing to look back at (lib/trips).
      trip: toTrip(
        {
          id: String(group[0].id),
          startedAt: group[0].created_at,
          query,
          vehicleClass,
          contacted: Math.max(contacted, humanSent.length ? 1 : 0),
          replied,
          best: best
            ? { pricePerDay: best.current, ask: best.ask, currency: best.currency }
            : null,
          booking: booking
            ? {
                vendorName: booking.vendor_name ?? "Rental shop",
                perDay: booking.price_per_day != null ? Number(booking.price_per_day) : null,
                total: booking.total_price != null ? Number(booking.total_price) : null,
                currency: booking.currency ?? "USD",
                scheduledAt: booking.scheduled_at,
              }
            : null,
          isLatest,
          lastEventAt,
        },
        now
      ),
    };
  });

  return NextResponse.json({ sessions, bookings });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
