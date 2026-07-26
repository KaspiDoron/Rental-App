import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { can } from "@/lib/entitlements";
import type { PlanId } from "@/lib/access";

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

  const ts = new URL(req.url).searchParams.get("ts") ?? "";
  const startMs = Date.parse(ts);
  if (!Number.isFinite(startMs)) {
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

  const gi = groups.findIndex((g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000);
  if (gi < 0) return NextResponse.json({ error: "That hunt is no longer available." }, { status: 404 });

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
      sbSelect<{ to_number: string; raw: { vendorId?: string; vendorName?: string } | null }>(
        "whatsapp_messages",
        `select=to_number,raw&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=120`
      ).catch(() => []),
      sbSelect<{ vendor_id: string | null; vendor_name: string | null; created_at: string }>(
        "offers",
        `select=vendor_id,vendor_name,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=120`
      ).catch(() => []),
    ]);
    const seen = new Map<string, { id: string; name: string }>();
    for (const m of outRows) {
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
