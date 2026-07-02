import { NextResponse } from "next/server";
import { placeDetails } from "@/lib/google";

// Real Google reviews for a vendor (Place Details). Requires the Maps key.
export async function GET(req: Request) {
  const placeId = new URL(req.url).searchParams.get("placeId") ?? "";
  if (!placeId) {
    return NextResponse.json({ error: "placeId required" }, { status: 400 });
  }
  const details = await placeDetails(placeId);
  if (!details) {
    return NextResponse.json({
      available: false,
      reviews: [],
      note: "Connect a Google Maps API key (Admin -> Keys) to load real Google reviews.",
    });
  }
  return NextResponse.json({
    available: true,
    rating: details.rating,
    total: details.total,
    reviews: details.reviews,
  });
}
