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
// from Places Nearby Search; otherwise clearly-labelled demo seeds so the
// product remains usable before keys are added.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.origin || typeof body.origin.lat !== "number") {
    return NextResponse.json({ error: "origin required" }, { status: 400 });
  }
  const radius = Math.min(50, Math.max(1, body.radiusKm || 8));
  const vClass: VehicleClass =
    body.vehicleClass && body.vehicleClass !== "any" ? body.vehicleClass : "car";

  const real = await findRealVendors(body.origin, radius, vClass);
  let vendors: Vendor[];
  let source: "google" | "demo";

  if (real) {
    source = "google";
    vendors = real.filter((v) => (v.distanceKm ?? 999) <= radius);
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

  // Save the search to agent memory (no-op without Supabase).
  const session = await getSession();
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

  return NextResponse.json({ vendors, source });
}
