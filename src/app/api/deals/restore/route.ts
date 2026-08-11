import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { can } from "@/lib/entitlements";
import type { PlanId } from "@/lib/access";
import { isSessionFresh } from "@/lib/session-life";
import { searchSessionTtlMs } from "@/lib/session-life-config";

export const dynamic = "force-dynamic";

// Trips restore (issue 8): rebuild the `wd_search`-shaped payload for a PAST
// search session so the traveller can re-open its full Find-Deals workspace
// (shops + RFQ + origin) instead of starting from scratch. The client writes
// the payload to sessionStorage and navigates home, where the existing
// rehydrate path renders it and the live polls re-apply the latest offers.
//
// Sources, in priority order:
//   1. searches.snapshot / searches.rfq  - the exact shops + RFQ this hunt ran
//      (stamped at search time). The complete restore.
//   2. Fallback for pre-snapshot sessions: the shops we actually MESSAGED
//      (outbound raws) plus any offers, and the RFQ from the newest outbound
//      raw. Honest partial - only contacted shops, surfaced in the UI copy.
//
// PRIVACY: everything is strictly scoped to the signed-in user's own rows.

const GROUP_GAP_MS = 30 * 60_000;

interface SnapshotVendor {
  id: string;
  name: string;
  whatsapp?: string;
  placeId?: string | null;
  rating?: number | null;
  reviews?: number | null;
  distanceKm?: number | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  vehicleClasses?: string[];
  fulfillment?: string[];
  partner?: boolean;
  demo?: boolean;
  basePricePerDay?: number;
  photoUrl?: string | null;
}

interface SearchRow {
  id: number;
  query_text: string | null;
  lat: number | null;
  lng: number | null;
  radius_km: number | null;
  vehicle_class: string | null;
  source: string | null;
  rfq: Record<string, unknown> | null;
  snapshot: SnapshotVendor[] | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // PRO GATE: restoring an OLDER hunt is a paid feature. The latest session is
  // always restorable (that is the live workspace); only earlier ones gate.
  const plan = (session.plan ?? "free") as PlanId;
  const hasHistory = can(plan, "trips-history");

  // `ts=latest` - "whatever hunt I was on". The iOS PWA can be killed at any
  // moment and sessionStorage goes with it, so the Find-deals screen needs to
  // ask for the newest session by name rather than by a timestamp it no longer
  // has. It is always index 0, which is always ungated (see the gate below), so
  // this opens no door the explicit path did not already open.
  const ts = new URL(req.url).searchParams.get("ts") ?? "";
  const wantLatest = ts === "latest";
  const startMs = Date.parse(ts);
  if (!wantLatest && !Number.isFinite(startMs)) {
    return NextResponse.json({ error: "ts (session start) required" }, { status: 400 });
  }
  const enc = encodeURIComponent(session.email);

  // 1. Recent search rows -> the same 30-min session grouping the Trips list uses.
  // Try the snapshot-bearing select first; fall back for a pre-migration DB.
  let rows = await sbSelect<SearchRow>(
    "searches",
    `select=id,query_text,lat,lng,radius_km,vehicle_class,source,rfq,snapshot,created_at&user_email=eq.${enc}&order=created_at.desc&limit=40`
  ).catch(() => null);
  if (rows === null) {
    rows = (
      await sbSelect<Omit<SearchRow, "rfq" | "snapshot">>(
        "searches",
        `select=id,query_text,lat,lng,radius_km,vehicle_class,source,created_at&user_email=eq.${enc}&order=created_at.desc&limit=40`
      ).catch(() => [])
    ).map((r) => ({ ...r, rfq: null, snapshot: null }));
  }
  if (!rows.length) return NextResponse.json({ error: "No searches found." }, { status: 404 });

  // BUILDING A REQUEST IS NOT RUNNING A HUNT.
  //
  // /api/profile writes a `searches` row on every RFQ build - both the LLM
  // profiler and the zero-token tap-to-build panel - stamped `results: 0` with
  // no snapshot and no rfq. Those rows are useful analytics and useless as
  // sessions, but they carry the newest `created_at`, so `ts=latest` picked one,
  // found no snapshot, and fell straight through to the contacted-shops
  // fallback. That is how a hunt the traveller had finished with came back
  // wearing a request they had merely started typing.
  //
  // Filtered in JS rather than in the query on purpose: PostgREST's `not.in`
  // resolves to NULL for a NULL `source`, which would silently exclude legacy
  // rows that predate the column being written.
  const BUILD_ONLY = new Set(["panel", "profiler"]);
  const hunts = rows.filter((r) => !BUILD_ONLY.has(String(r.source ?? "")));
  if (!hunts.length) return NextResponse.json({ error: "No searches found." }, { status: 404 });
  rows = hunts;

  const asc = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const groups: SearchRow[][] = [];
  for (const row of asc) {
    const last = groups[groups.length - 1];
    if (last && Date.parse(row.created_at) - Date.parse(last[last.length - 1].created_at) <= GROUP_GAP_MS) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }
  groups.reverse(); // newest session first, matching the Trips list order

  const gi = wantLatest
    ? 0
    : groups.findIndex((g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000);
  if (gi < 0) return NextResponse.json({ error: "That hunt is no longer available." }, { status: 404 });

  // A HUNT HAS AN END. `ts=latest` is the AUTO-restore the Find-deals screen
  // fires on every cold mount, and it used to mean "the newest row in this
  // table" with no upper bound on age - so a traveller who searched once, a week
  // ago, opened the app and was handed that week-old hunt as their live
  // workspace, complete with "the agents never stopped". They had stopped.
  //
  // The freshness gate is deliberately ONLY on the automatic path. An explicit
  // `ts=<timestamp>` comes from a tap in Trips - the traveller asking for a
  // specific past hunt by name - and that must keep working at any age. This is
  // the whole difference between history and the live board.
  if (wantLatest) {
    const ttlMs = await searchSessionTtlMs();
    if (!isSessionFresh(Date.parse(groups[0][0].created_at), Date.now(), ttlMs)) {
      return NextResponse.json(
        { error: "no-live-hunt", hint: "Your last hunt has ended - it is saved in Trips." },
        { status: 404 }
      );
    }
  }

  // Gate: everything except the newest session needs trips-history.
  if (gi > 0 && !hasHistory) {
    return NextResponse.json(
      { error: "upgrade-required", feature: "trips-history" },
      { status: 402 }
    );
  }

  const group = groups[gi];
  const start = Date.parse(group[0].created_at);
  const end = gi === 0 ? Infinity : Date.parse(groups[gi - 1][0].created_at);
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return t >= start - 1000 && t < end;
  };

  // CLEARED MEANS CLEARED, AT ANY AGE.
  //
  // "Clear search" writes a `session-closed` marker row (see
  // /api/session/close), purges the outbox and tombstones every recipient - and
  // then the very next cold load restored the exact same hunt, because this
  // route never looked at the marker. Dismissing a hunt and having it come back
  // is worse than the staleness itself: it reads as the app ignoring you.
  //
  // The marker is a `whatsapp_messages` row with `to_number = 'session'`, which
  // the vendor rollup below skips (no vendorId), so it was invisible here.
  //
  // BOUNDS MATTER MORE THAN THEY LOOK. The marker must fall AFTER this group's
  // newest search and BEFORE the next group begins. Comparing against the
  // group's FIRST row instead would break the commonest real sequence there is -
  // search, clear, search again within the 30-minute grouping window - because
  // those two searches land in ONE group and the clear between them sits after
  // its start. The traveller's brand-new hunt would refuse to restore.
  const groupEndIso = group[group.length - 1].created_at;
  const nextGroupIso = gi > 0 ? groups[gi - 1][0].created_at : null;
  const closedRows = await sbSelect<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=eq.session-closed` +
      `&received_at=gt.${encodeURIComponent(groupEndIso)}` +
      (nextGroupIso ? `&received_at=lt.${encodeURIComponent(nextGroupIso)}` : "") +
      `&order=received_at.desc&limit=1`
  ).catch(() => []);
  if (closedRows.length) {
    return NextResponse.json(
      { error: "session-closed", hint: "You cleared this hunt." },
      { status: 404 }
    );
  }

  const withSnap = group.find((r) => Array.isArray(r.snapshot) && r.snapshot.length);
  const rfqRow = [...group].reverse().find((r) => r.rfq && typeof r.rfq === "object");
  const originRow = [...group].reverse().find((r) => r.lat != null && r.lng != null);
  const vehicleClass = [...group].reverse().find((r) => r.vehicle_class)?.vehicle_class ?? null;
  const radiusKm = [...group].reverse().find((r) => r.radius_km != null)?.radius_km ?? null;
  const source = group.find((r) => r.source)?.source ?? "demo";
  const query = group.find((r) => r.query_text)?.query_text ?? "";

  // 2. RFQ: the stamped snapshot wins; else the newest outbound raw.rfq in the
  // window; else a minimal RFQ from the recorded vehicle class.
  let rfq: Record<string, unknown> | null = rfqRow?.rfq ?? null;
  if (!rfq) {
    const outRows = await sbSelect<{ raw: { rfq?: Record<string, unknown> } | null; received_at: string }>(
      "whatsapp_messages",
      `select=raw,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=40`
    ).catch(() => []);
    rfq = outRows.find((r) => inWindow(r.received_at) && r.raw?.rfq)?.raw?.rfq ?? null;
  }
  if (!rfq) {
    rfq = {
      vehicleClass: vehicleClass ?? "scooter",
      durationDays: 3,
      fulfillment: "any",
      accessories: [],
    };
  }

  // 3. Vendors: the snapshot rehydrated into full Vendor shapes. Fallback path
  // reconstructs the CONTACTED shops from outbound raws + offers (partial).
  let vendors: unknown[] = [];
  let partial = false;
  if (withSnap?.snapshot) {
    vendors = withSnap.snapshot.map((v) => ({
      id: v.id,
      name: v.name,
      lat: v.lat ?? originRow?.lat ?? 0,
      lng: v.lng ?? originRow?.lng ?? 0,
      rating: v.rating ?? 0,
      reviews: v.reviews ?? 0,
      vehicleClasses: v.vehicleClasses ?? (vehicleClass ? [vehicleClass] : []),
      fulfillment: v.fulfillment ?? ["pickup"],
      whatsapp: v.whatsapp ?? "",
      basePricePerDay: v.basePricePerDay ?? 0,
      partner: v.partner ?? false,
      demo: v.demo ?? false,
      placeId: v.placeId ?? undefined,
      address: v.address ?? undefined,
      distanceKm: v.distanceKm ?? undefined,
      photoUrl: v.photoUrl ?? undefined,
      stage: "queued",
    }));
  } else {
    partial = true;
    const [outRows, offerRows] = await Promise.all([
      sbSelect<{
        to_number: string;
        received_at: string;
        raw: { vendorId?: string; vendorName?: string } | null;
      }>(
        "whatsapp_messages",
        `select=to_number,received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&received_at=gte.${encodeURIComponent(
          group[0].created_at
        )}&order=received_at.desc&limit=120`
      ).catch(() => []),
      sbSelect<{ vendor_id: string | null; vendor_name: string | null; created_at: string }>(
        "offers",
        `select=vendor_id,vendor_name,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=120`
      ).catch(() => []),
    ]);
    // THE FALLBACK NEEDED THE SAME FENCE AS THE PRIMARY PATH.
    //
    // `offerRows` below was already window-filtered; `outRows` was not, so this
    // branch reached back over the last 120 outbound messages of ALL TIME and
    // pinned them onto whichever hunt was being restored. That is a second,
    // independent route to the stale-session bug, and it fires precisely when
    // the snapshot is missing - which happens on every `searches` row written by
    // /api/profile (a bare RFQ build records a row with no snapshot at all).
    const seen = new Map<string, { id: string; name: string }>();
    for (const m of outRows) {
      if (!inWindow(m.received_at)) continue;
      const id = m.raw?.vendorId || m.to_number;
      if (id && !seen.has(id)) seen.set(id, { id, name: m.raw?.vendorName || id });
    }
    for (const o of offerRows) {
      if (!inWindow(o.created_at)) continue;
      const id = o.vendor_id || o.vendor_name || "";
      if (id && !seen.has(id)) seen.set(id, { id, name: o.vendor_name || id });
    }
    vendors = [...seen.values()].map((v) => ({
      id: v.id,
      name: v.name,
      lat: originRow?.lat ?? 0,
      lng: originRow?.lng ?? 0,
      rating: 0,
      reviews: 0,
      vehicleClasses: vehicleClass ? [vehicleClass] : [],
      fulfillment: ["pickup"],
      whatsapp: /^\d{6,}$/.test(v.id) ? v.id : "",
      basePricePerDay: 0,
      partner: false,
      demo: false,
      stage: "queued",
    }));
  }

  if (!vendors.length) {
    return NextResponse.json({ error: "Nothing to restore from that hunt." }, { status: 404 });
  }

  // WHERE THEY LEFT OFF, not a blank board.
  //
  // Every restored shop used to come back stamped `stage: "queued"`, so
  // re-opening a hunt showed a list that looked like it had never run - the
  // conversations, the prices and the whole point of coming back were gone
  // until several polls had caught up, and for a hunt whose window has closed
  // they never came back at all. The state is right here in the same rows the
  // window is defined by, so it is restored WITH the shops.
  {
    const [msgRows, offerRows] = await Promise.all([
      sbSelect<{
        to_number: string;
        direction: string;
        received_at: string;
        raw: { vendorId?: string; sender?: string } | null;
      }>(
        "whatsapp_messages",
        `select=to_number,direction,received_at,raw&or=(raw->>sender.eq.${enc},raw->>receiver.eq.${enc})&order=received_at.desc&limit=250`
      ).catch(() => []),
      sbSelect<{
        vendor_id: string | null;
        price_per_day: number | null;
        list_price_per_day: number | null;
        currency: string | null;
        round: number | null;
        verified: boolean | null;
        created_at: string;
      }>(
        "offers",
        `select=vendor_id,price_per_day,list_price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=200`
      ).catch(() => []),
    ]);

    const messaged = new Set<string>();
    const replied = new Set<string>();
    for (const m of msgRows) {
      if (!inWindow(m.received_at)) continue;
      const id = m.raw?.vendorId;
      if (!id) continue;
      if (m.direction === "outbound") messaged.add(id);
      else replied.add(id);
    }
    const bestByVendor = new Map<string, (typeof offerRows)[number]>();
    for (const o of offerRows) {
      if (!o.vendor_id || !inWindow(o.created_at) || bestByVendor.has(o.vendor_id)) continue;
      if (o.price_per_day && o.price_per_day > 0) bestByVendor.set(o.vendor_id, o);
    }

    const durationDays =
      typeof (rfq as { durationDays?: unknown }).durationDays === "number"
        ? ((rfq as { durationDays: number }).durationDays as number)
        : 1;

    vendors = (vendors as Record<string, unknown>[]).map((v) => {
      const id = String(v.id ?? "");
      const priced = bestByVendor.get(id);
      if (priced) {
        const perDay = priced.price_per_day as number;
        return {
          ...v,
          stage: "offer-received",
          offer: {
            pricePerDay: perDay,
            listPricePerDay: priced.list_price_per_day ?? perDay,
            currency: priced.currency ?? "USD",
            totalPrice: Math.round(perDay * durationDays),
            includesInsurance: false,
            includesDelivery: false,
            message: "",
            round: priced.round ?? 0,
            verified: Boolean(priced.verified),
            simulated: false,
            // The live polls fill in deposit + fulfillment; until then the card
            // says "confirming details" rather than offering a premature lock.
            presentable: false,
          },
        };
      }
      if (replied.has(id)) return { ...v, stage: "negotiating" };
      if (messaged.has(id)) return { ...v, stage: "awaiting-response" };
      return v;
    });
  }

  const payload = {
    vendors,
    rfq,
    source,
    sourceError: null,
    rawText: query,
    origin:
      originRow?.lat != null && originRow?.lng != null
        ? { lat: originRow.lat, lng: originRow.lng, label: "" }
        : null,
    radiusKm: typeof radiusKm === "number" ? radiusKm : 8,
    searchEpoch: start,
  };

  return NextResponse.json({ ok: true, partial, payload });
}
