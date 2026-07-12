import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Live feed of the signed-in user's vendor replies (auto-ingested by the
// WhatsApp webhook or added manually). The app polls this while agents are
// waiting on shops, so confirmed offers pop into the cards by themselves and
// the traveller never leaves the app.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // ATOMIC SESSION: the client passes the epoch its current search started at;
  // only replies created since then belong to this session. This is what stops
  // a previous search's offers/threads from resurfacing on a new search.
  const sinceMs = Number(new URL(req.url).searchParams.get("since") ?? 0);
  const sinceFilter =
    sinceMs > 0
      ? `&created_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}`
      : "";

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

  interface ReplyRow {
    id: number;
    vendor_id: string;
    vendor_name: string;
    reply_text: string;
    found: boolean;
    price_per_day: number | null;
    matches_spec: boolean;
    confidence: string;
    auto: boolean;
    currency?: string | null;
    deposit?: string | null;
    deposit_type?: string | null;
    deposit_amount?: number | null;
    deposit_currency?: string | null;
    delivers?: boolean | null;
    insurance_included?: boolean | null;
    delivery_fee?: number | null;
    created_at: string;
  }
  const filter = `user_email=eq.${encodeURIComponent(session.email)}${sinceFilter}&order=created_at.desc&limit=40`;
  let rows = await sbSelect<ReplyRow>(
    "vendor_replies",
    `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,deposit_type,deposit_amount,deposit_currency,delivers,insurance_included,delivery_fee,created_at&${filter}`
  );
  if (rows.length === 0) {
    // A select naming a not-yet-migrated column fails SILENTLY as [] - the
    // feed must keep working before the owner runs the newest schema.
    rows = await sbSelect<ReplyRow>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at&${filter}`
    );
  }
  if (rows.length === 0) {
    rows = await sbSelect<ReplyRow>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,created_at&${filter}`
    );
  }

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
      currency: r.currency ?? null, // the shop's own money - never defaulted here
      deposit: r.deposit ?? null,
      depositType: r.deposit_type ?? null,
      depositAmount: r.deposit_amount ?? null,
      depositCurrency: r.deposit_currency ?? null,
      delivers: r.delivers ?? null,
      insuranceIncluded: r.insurance_included ?? null,
      deliveryFee: r.delivery_fee ?? null,
      createdAt: r.created_at,
    })),
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
