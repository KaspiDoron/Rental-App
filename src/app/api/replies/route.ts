import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Live feed of the signed-in user's vendor replies (auto-ingested by the
// WhatsApp webhook or added manually). The app polls this while agents are
// waiting on shops, so confirmed offers pop into the cards by themselves and
// the traveller never leaves the app.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Reliability core: reconcile replies the webhook may have MISSED (the
  // Evolution host can be restarting exactly when a shop answers). Throttled
  // to one real pull per user per ~25s, so most polls skip it instantly.
  try {
    const { syncInboundReplies } = await import("@/lib/wa-sync");
    await syncInboundReplies(session.email);
  } catch {
    /* the DB feed below still answers */
  }
  // Any user activity also flushes due queued messages (no dedicated worker).
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    await drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
  } catch {
    /* best-effort */
  }

  const rows = await sbSelect<{
    id: number;
    vendor_id: string;
    vendor_name: string;
    reply_text: string;
    found: boolean;
    price_per_day: number | null;
    matches_spec: boolean;
    confidence: string;
    auto: boolean;
    currency: string | null;
    deposit: string | null;
    delivers: boolean | null;
    created_at: string;
  }>(
    "vendor_replies",
    `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at&user_email=eq.${encodeURIComponent(
      session.email
    )}&order=created_at.desc&limit=40`
  );

  return NextResponse.json({
    replies: rows.map((r) => ({
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      replyText: r.reply_text,
      found: r.found,
      pricePerDay: r.price_per_day,
      verified: r.matches_spec && r.confidence === "high",
      auto: r.auto,
      currency: r.currency, // the shop's own money - never defaulted here
      deposit: r.deposit,
      delivers: r.delivers,
      createdAt: r.created_at,
    })),
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
