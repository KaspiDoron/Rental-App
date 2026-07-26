import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { digitsOnly } from "@/lib/phone";

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

  const digits = digitsOnly(new URL(req.url).searchParams.get("number") ?? "");
  if (!digits || digits.length < 6) return NextResponse.json({ url: null });

  const { sbSelect } = await import("@/lib/runtime-config");
  const known = await sbSelect<{ id: number }>(
    "whatsapp_messages",
    `select=id&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      digits
    )}&raw->>sender=eq.${encodeURIComponent(session.email)}&limit=1`
  ).catch(() => []);
  if (known.length === 0) {
    // Not one of your threads - answer the same way a missing picture answers,
    // so this can never be used to probe which numbers exist.
    return NextResponse.json({ url: null });
  }

  const { fetchProfilePictureUrl } = await import("@/lib/evolution");
  const url = await fetchProfilePictureUrl(session.email, digits).catch(() => null);
  // private: this URL is scoped to one traveller's session, never a shared cache.
  return NextResponse.json({ url }, { headers: { "Cache-Control": "private, no-store" } });
}
