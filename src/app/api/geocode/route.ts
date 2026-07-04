import { NextResponse } from "next/server";
import { searchPlaces } from "@/lib/google";

// Address / hotel search: Google Geocoding when configured, OpenStreetMap
// Nominatim otherwise. Real data either way - no dummy dropdowns.
export async function GET(req: Request) {
  const { getSession } = await import("@/lib/session");
  const session = await getSession();
  if (!session) return NextResponse.json({ results: [] });
  const { checkDailyLimit, killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) return NextResponse.json({ results: [] });
  const gate = await checkDailyLimit("geocode", session.email, "LIMIT_GEOCODE_PER_DAY");
  if (!gate.allowed) return NextResponse.json({ results: [] });

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ results: [] });
  const results = await searchPlaces(q);
  return NextResponse.json({ results });
}
