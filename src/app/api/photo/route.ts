import { mapsKey } from "@/lib/google";

// Streams a Google Places photo without exposing the API key to the browser.
// Supports both APIs:
//   ?name=places/XXX/photos/YYY  - Places API (New) photo resource name
//   ?ref=<photo_reference>       - legacy Places photo reference
export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const ref = url.searchParams.get("ref") ?? "";
  const key = await mapsKey();
  if ((!ref && !name) || !key) return new Response(null, { status: 404 });

  const target = name
    ? `https://places.googleapis.com/v1/${name}/media?key=${key}&maxWidthPx=800`
    : `https://maps.googleapis.com/maps/api/place/photo?maxwidth=640&photo_reference=${encodeURIComponent(
        ref
      )}&key=${key}`;

  const res = await fetch(target, { cache: "no-store" });
  if (!res.ok || !res.body) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
