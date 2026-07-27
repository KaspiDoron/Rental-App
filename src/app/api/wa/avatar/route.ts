import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { numberFilter, waDigits } from "@/lib/wa/phone-key";

// EPHEMERAL SHOP AVATAR.
//
// Returns the WhatsApp profile picture URL for a shop the signed-in user has
// ACTUALLY messaged. Two rules make this safe to ship:
//
//  1. NOTHING IS PERSISTED. No table is written, no column exists. The URL is
//     held in a bounded in-process cache (evolution.ts) for a few minutes and in
//     React state for the length of one search, and vanishes with both. This is
//     someone else's profile photo; it is not ours to keep.
//  2. OWNERSHIP IS PROVED. The number must appear as a destination in THIS
//     user's own outbound history - the same predicate
//     /api/negotiate/consent uses - so a tampered client cannot enumerate
//     strangers' profile pictures through our WhatsApp session.
//
// A miss is a normal outcome (most shops have no picture, or hide it): the UI
// falls back to an initial letter, so this never blocks a render.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const digits = waDigits(new URL(req.url).searchParams.get("number") ?? "");
  if (!digits || digits.length < 6) return NextResponse.json({ url: null });

  const { sbSelect } = await import("@/lib/runtime-config");
  // OWNERSHIP = "this is one of your threads". A message the user has QUEUED to
  // this shop proves that just as well as one already delivered - and it is the
  // common case at the start of a search, when the whole batch is still parked
  // and not one outbound row exists yet. Requiring a sent message meant every
  // avatar on the board stayed a grey initial until the queue drained, which is
  // exactly what "none of the shop images load" looked like.
  //
  // NUMBER MATCHING IS TOLERANT (numberFilter). This check used to be an exact
  // `to_number=eq.` against the number the CLIENT holds, while the queue row was
  // written from whatever spelling discovery produced. When the two differed -
  // Google hands out national numbers, WhatsApp international ones - ownership
  // could not be proved for ANY shop, so every avatar on the board answered
  // `null` and the whole board stayed grey initials. That is the entire bug.
  const [sent, queued] = await Promise.all([
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        session.email
      )}&limit=1${numberFilter("to_number", digits)}`
    ).catch(() => []),
    sbSelect<{ id: number }>(
      "wa_outbox",
      `select=id&sender_key=eq.${encodeURIComponent(session.email)}&limit=1${numberFilter(
        "to_number",
        digits
      )}`
    ).catch(() => []),
  ]);
  if (sent.length === 0 && queued.length === 0) {
    // Not one of your threads - answer the same way a missing picture answers,
    // so this can never be used to probe which numbers exist.
    return NextResponse.json({ url: null });
  }

  const { fetchProfilePicture } = await import("@/lib/evolution");
  const pic = await fetchProfilePicture(session.email, digits).catch(() => ({
    url: null as string | null,
    error: "lookup failed",
  }));

  // IMAGE MODE: stream the bytes ourselves.
  //
  // WhatsApp serves avatars from pps.whatsapp.net behind signed, short-lived
  // URLs. Handing one to an <img src> works only until the CDN decides it does
  // not like the request - and when it refuses there is nothing to see and no
  // way to tell that apart from a shop with no photo. Proxying makes the render
  // depend on OUR fetch, and it keeps the shop's CDN URL server-side, which is
  // also the right answer for a photo that is not ours to hand around.
  const wantsImage = new URL(req.url).searchParams.get("img") === "1";
  if (wantsImage) {
    if (!pic.url) return new NextResponse(null, { status: 404, headers: NO_STORE });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(pic.url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) {
        return new NextResponse(null, { status: 404, headers: NO_STORE });
      }
      // CACHEABLE, PRIVATELY. `no-store` meant a card scrolled out and back
      // re-fetched the shop's CDN photo every time - fifteen shops, every
      // scroll, and an avatar that was still arriving when the traveller had
      // moved on. `private` keeps it out of every shared cache, so this is the
      // traveller's own browser holding it for a few minutes, which is exactly
      // as long as the in-process cache already holds the URL. Nothing is
      // written to a database by this path, then or now.
      return new NextResponse(res.body, {
        status: 200,
        headers: { ...AVATAR_CACHE, "Content-Type": type },
      });
    } catch {
      return new NextResponse(null, { status: 404, headers: NO_STORE });
    }
  }

  // JSON mode: the client gets OUR url, never WhatsApp's.
  return NextResponse.json(
    {
      url: pic.url
        ? `/api/wa/avatar?img=1&number=${encodeURIComponent(digits)}`
        : null,
      // Present only on a genuine failure - a shop with no photo reports none.
      error: pic.error,
    },
    { headers: NO_STORE }
  );
}

// private: an avatar is scoped to one traveller's session, never shared-cached.
const NO_STORE = { "Cache-Control": "private, no-store" };
// Long enough that scrolling the board is free, short enough that the picture
// is never the app's to keep. Never shared - this is one traveller's session.
const AVATAR_CACHE = { "Cache-Control": "private, max-age=600" };
