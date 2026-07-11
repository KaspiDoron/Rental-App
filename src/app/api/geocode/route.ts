import { NextResponse } from "next/server";
import { searchPlaces, reverseGeocode } from "@/lib/google";

// Address / hotel search: Google Geocoding when configured, OpenStreetMap
// Nominatim otherwise. Real data either way - no dummy dropdowns.
// With ?lat=&lng= it REVERSE-geocodes the traveller's GPS point into a real,
// named place (so "My current location" becomes e.g. "Bophut, Koh Samui,
// Thailand" and the local currency / language can be resolved from it).
export async function GET(req: Request) {
  const { getSession } = await import("@/lib/session");
  const session = await getSession();
  if (!session) return NextResponse.json({ results: [] });
  const { checkDailyLimit, killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) return NextResponse.json({ results: [] });
  const gate = await checkDailyLimit("geocode", session.email, "LIMIT_GEOCODE_PER_DAY");
  if (!gate.allowed) return NextResponse.json({ results: [] });

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const place = await reverseGeocode(lat, lng);
    return NextResponse.json({ place });
  }

  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ results: [] });
  const results = await searchPlaces(q);
  return NextResponse.json({ results });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
