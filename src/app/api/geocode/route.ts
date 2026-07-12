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
  if (!session) return NextResponse.json({ results: [], error: "signed-out" });
  // Management is never rate-limited here (the training studio depends on this
  // search), and every silent empty answer now says WHY - a mute dropdown made
  // the trainer look broken.
  if (session.role === "user") {
    const { checkDailyLimit, killSwitchOn } = await import("@/lib/usage");
    if (await killSwitchOn()) return NextResponse.json({ results: [], error: "paused" });
    const gate = await checkDailyLimit("geocode", session.email, "LIMIT_GEOCODE_PER_DAY");
    if (!gate.allowed) return NextResponse.json({ results: [], error: "daily-limit" });
  }

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const place = await reverseGeocode(lat, lng);
    return NextResponse.json({ place });
  }

  const q = url.searchParams.get("q")?.trim() ?? "";
  // Suggest from 2 characters up (owner request: the most responsive autocomplete).
  if (q.length < 2) return NextResponse.json({ results: [] });
  const { results, error } = await searchPlaces(q);
  return NextResponse.json({ results, error });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
