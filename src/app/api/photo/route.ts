import { mapsKey } from "@/lib/google";

// Streams a Google Places photo without exposing the API key to the browser.
// Supports both APIs:
//   ?name=places/XXX/photos/YYY  - Places API (New) photo resource name
//   ?ref=<photo_reference>       - legacy Places photo reference
//
// WHY THIS ROUTE IS LOUD NOW. It used to answer every failure - bad input, no
// key, Google refusing, a timeout - with an identical bare 404 and no log. When
// every shop photo on the app went blank, that 404 said nothing about which of
// those four had happened, and the Maps doctor never fetched an image at all,
// so the diagnostics panel read all-green. A proxy that cannot explain itself
// costs more than it saves: each failure now carries its reason on the response
// and in the server log, and `runMapsDiagnostics` pulls a real image so the
// owner can read Google's own words in one tap.
//
// Strict input shapes remain: a crafted value must never be able to inject
// query params (a "?" in `name` would turn /media?key=... into an arbitrary
// authenticated Google call billed to the owner's key).

// Google's resource ids are URL-safe base64-ish. The name is anchored to the
// exact two-segment shape; the reference is a single opaque token. Neither may
// contain "?", "&", "#" or a path separator, which is the whole security point.
const NAME_RX = /^places\/[A-Za-z0-9_.~-]{1,256}\/photos\/[A-Za-z0-9_.~-]{1,2048}$/;
const REF_RX = /^[A-Za-z0-9_.~-]{1,2048}$/;

/** A failure must never be cached: once broken it would stay broken for the
 *  whole session even after the real cause cleared. */
const FAIL_HEADERS = { "Cache-Control": "private, no-store" };

function fail(status: number, reason: string): Response {
  // Visible in Safari's network inspector and in any log pipeline, without
  // leaking the key or the upstream URL.
  console.warn(`[api/photo] ${status} ${reason}`);
  return new Response(null, {
    status,
    headers: { ...FAIL_HEADERS, "X-Photo-Error": reason.slice(0, 200) },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const ref = url.searchParams.get("ref") ?? "";

  if (!ref && !name) return fail(400, "no name or ref");
  if (name && !NAME_RX.test(name)) return fail(400, "malformed photo name");
  if (!name && ref && !REF_RX.test(ref)) return fail(400, "malformed photo ref");

  const key = await mapsKey();
  if (!key) return fail(503, "no Google Maps key configured");

  const target = name
    ? `https://places.googleapis.com/v1/${name}/media?key=${key}&maxWidthPx=800`
    : `https://maps.googleapis.com/maps/api/place/photo?maxwidth=640&photo_reference=${encodeURIComponent(
        ref
      )}&key=${key}`;

  // Bound the header wait so a stalled Google media endpoint cannot hang this
  // proxy invocation until the request-timeout ceiling - browser fan-out (up to
  // 12 photo URLs per result view) would otherwise pile hung invocations against
  // the concurrency ceiling and starve real routes. The timer is cleared once
  // headers arrive; the body then streams straight to the client.
  //
  // ONE retry, because a single cold-start blip should not blank an entire
  // results page - which is how this presented: every card at once.
  let res: Response | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 250));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      res = await fetch(target, {
        cache: "no-store",
        signal: ctrl.signal,
        headers: { Accept: "image/*" },
      });
    } catch (e) {
      lastError = e instanceof Error ? e.name === "AbortError" ? "upstream timed out (10s)" : e.message : "network error";
      res = null;
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) break;
    // Read Google's own explanation - "Places API (New) has not been used in
    // project X", "quota exceeded" and "API key not valid" are different
    // problems with different fixes, and the old 404 hid all three.
    const body = await res.text().catch(() => "");
    let msg = "";
    try {
      msg = JSON.parse(body)?.error?.message ?? "";
    } catch {
      msg = body.replace(/\s+/g, " ").slice(0, 200);
    }
    lastError = `Google ${res.status}${msg ? `: ${msg}` : ""}`;
    // 4xx is a settled answer (bad id, key refused) - retrying just burns quota.
    if (res.status < 500) return fail(502, lastError);
    res = null;
  }

  if (!res || !res.body) return fail(502, lastError || "no image body");

  const type = res.headers.get("Content-Type") ?? "image/jpeg";
  if (!type.startsWith("image/")) return fail(502, `upstream returned ${type}, not an image`);

  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      // Only a SUCCESSFUL image is cacheable, and it is public: a shop photo is
      // the same for everyone and never traveller-specific.
      "Cache-Control": "public, max-age=86400",
    },
  });
}
