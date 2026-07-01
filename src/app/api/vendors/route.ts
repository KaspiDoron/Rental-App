import { NextResponse } from "next/server";
import { seedVendors } from "@/lib/vendors";
import { haversineKm } from "@/lib/geo";
import type { Vendor, VehicleClass, Fulfillment } from "@/lib/types";

interface Body {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vehicleClass?: VehicleClass | "any";
  fulfillment?: Fulfillment;
  minRating?: number;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.origin || typeof body.origin.lat !== "number") {
    return NextResponse.json({ error: "origin required" }, { status: 400 });
  }
  const radius = Math.min(50, Math.max(1, body.radiusKm || 8));

  let vendors: Vendor[] = seedVendors(body.origin)
    .map((v) => ({ ...v, distanceKm: haversineKm(body.origin, v) }))
    .filter((v) => (v.distanceKm ?? 999) <= radius);

  if (body.vehicleClass && body.vehicleClass !== "any") {
    vendors = vendors.filter((v) =>
      v.vehicleClasses.includes(body.vehicleClass as VehicleClass)
    );
  }
  if (body.fulfillment && body.fulfillment !== "any") {
    vendors = vendors.filter((v) =>
      v.fulfillment.includes(body.fulfillment as Fulfillment)
    );
  }
  if (body.minRating) {
    vendors = vendors.filter((v) => v.rating >= (body.minRating as number));
  }

  vendors.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return NextResponse.json({ vendors });
}
