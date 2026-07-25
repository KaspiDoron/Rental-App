import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { floorPriceFor } from "@/lib/market";
import type { StructuredRFQ } from "@/lib/types";

// Local going-rate hint for the search screen (item #6): as soon as the
// traveller picks their stay, we show what the cheapest scooter and economy
// car realistically cost per day around there - researched country seeds
// first, area-accurate AI rows once the market table has them. This is the
// same floor the bargaining agent anchors to, so the hint is honest.

const baseRfq: Omit<StructuredRFQ, "vehicleClass"> = {
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
};

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const region = (new URL(req.url).searchParams.get("region") ?? "").trim();
  if (!region) return NextResponse.json({ scooter: null, car: null });

  // Anchor the hint on the CHEAPEST real vehicles the market floor tracks: a
  // 110cc automatic scooter and a small 4-seat economy car.
  const [scooter, car] = await Promise.all([
    floorPriceFor(region, { ...baseRfq, vehicleClass: "scooter", engineSizeCc: 110 }).catch(() => null),
    floorPriceFor(region, { ...baseRfq, vehicleClass: "car", carType: "economy" }).catch(() => null),
  ]);

  return NextResponse.json({ scooter, car });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
