import { NextResponse } from "next/server";
import { placeDetails } from "@/lib/google";
import { rateLimit, clientIp } from "@/lib/rate-limit";

// Real Google reviews for a vendor (Place Details). Requires the Maps key.
export async function GET(req: Request) {
  // THROTTLE. This route spends the owner's billed Google Places quota per
  // request and needs no session, while every other Google consumer in the app
  // is session-gated and daily-capped. A per-ip window closes the open drain.
  const ip = clientIp(req);
  const gate = await rateLimit("reviews", ip, 30, 3600);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "Too many review lookups - try again shortly." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
    );
  }

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
