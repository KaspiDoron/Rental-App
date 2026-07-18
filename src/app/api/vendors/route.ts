import { NextResponse } from "next/server";
import { seedVendors } from "@/lib/vendors";
import { haversineKm } from "@/lib/geo";
import { findRealVendors } from "@/lib/google";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import type { Vendor, VehicleClass, Fulfillment } from "@/lib/types";

interface Body {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vehicleClass?: VehicleClass | "any";
  fulfillment?: Fulfillment;
  minRating?: number;
}

// Vendor discovery. With a Google Maps key this returns REAL rental businesses
// from Google Places. Demo seeds appear ONLY when no key is configured; if a
// key IS configured but Google rejects it, we return the exact error instead
// of silently showing dummy shops.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { killSwitchOn, checkDailyLimit } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "WheelDeal is temporarily paused by the owner." },
      { status: 503 }
    );
  }
  const gate = await checkDailyLimit("search", session.email, "LIMIT_SEARCHES_PER_DAY");
  if (!gate.allowed) {
    return NextResponse.json(
      {
        error: `Daily search limit reached (${gate.limit}/day) - this keeps the service free for everyone. Try again tomorrow.`,
      },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  // Validate BOTH coordinates and their ranges - a valid lat with a string/NaN
  // lng silently produced NaN haversine distances (every vendor filtered out) and
  // a corrupt searches row.
  const lat = body?.origin?.lat;
  const lng = body?.origin?.lng;
  if (
    !body?.origin ||
    typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180
  ) {
    return NextResponse.json({ error: "valid origin (lat/lng) required" }, { status: 400 });
  }
  const radius = Math.min(50, Math.max(1, body.radiusKm || 8));
  const vClass: VehicleClass =
    body.vehicleClass && body.vehicleClass !== "any" ? body.vehicleClass : "car";

  const real = await findRealVendors(body.origin, radius, vClass);
  let vendors: Vendor[];
  let source: "google" | "demo" | "google-error";
  let sourceError: string | undefined;

  if (real.vendors) {
    source = "google";
    vendors = real.vendors.filter((v) => (v.distanceKm ?? 999) <= radius);
  } else if (real.error) {
    // A key is configured but Google refused it - never mask this with demo data.
    source = "google-error";
    sourceError = real.error;
    vendors = [];
  } else {
    source = "demo";
    vendors = seedVendors(body.origin)
      .map((v) => ({ ...v, distanceKm: haversineKm(body.origin, v) }))
      .filter((v) => (v.distanceKm ?? 999) <= radius)
      .filter(
        (v) =>
          !body.vehicleClass ||
          body.vehicleClass === "any" ||
          v.vehicleClasses.includes(body.vehicleClass)
      );
  }

  if (body.fulfillment && body.fulfillment !== "any") {
    vendors = vendors.filter((v) => v.fulfillment.includes(body.fulfillment as Fulfillment));
  }
  if (body.minRating) {
    vendors = vendors.filter((v) => v.rating >= (body.minRating as number));
  }
  vendors.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  // Social proof: how many WheelDeal bookings each shop already has.
  try {
    const { sbSelect } = await import("@/lib/runtime-config");
    const rows = await sbSelect<{ vendor_id: string }>(
      "bookings",
      "select=vendor_id&limit=2000"
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.vendor_id] = (counts[r.vendor_id] ?? 0) + 1;
    vendors = vendors.map((v) => ({ ...v, orders: counts[v.id] ?? 0 }));
  } catch {}

  // Save the search to agent memory (no-op without Supabase).
  await sbInsert("searches", [
    {
      user_email: session?.email ?? null,
      lat: body.origin.lat,
      lng: body.origin.lng,
      radius_km: radius,
      vehicle_class: vClass,
      source,
      results: vendors.length,
    },
  ]);

  return NextResponse.json({ vendors, source, sourceError });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
