import { mapsKey } from "@/lib/google";

// Streams a Google Places photo without exposing the API key to the browser.
export async function GET(req: Request) {
  const ref = new URL(req.url).searchParams.get("ref") ?? "";
  const key = await mapsKey();
  if (!ref || !key) return new Response(null, { status: 404 });

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=640&photo_reference=${encodeURIComponent(
      ref
    )}&key=${key}`,
    { cache: "no-store" }
  );
  if (!res.ok || !res.body) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
