import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

// The "My deals" hub: the caller's confirmed bookings plus the freshest real
// offer per shop that is still on the table. Read-only and strictly scoped to
// the signed-in user.

interface OfferRow {
  id: number;
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  currency: string | null;
  round: number | null;
  verified: boolean | null;
  presentable?: boolean | null;
  fulfillment?: string | null;
  duration_days?: number | null;
  created_at: string;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const email = encodeURIComponent(session.email);

  const [bookings, offers] = await Promise.all([
    sbSelect(
      "bookings",
      `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&user_email=eq.${email}&order=created_at.desc&limit=25`
    ),
    (async () => {
      // Rich select first; pre-migration fallback without the newer columns
      // (a select naming an unknown column comes back empty, same pattern as
      // /api/bookings).
      let rows = await sbSelect<OfferRow>(
        "offers",
        `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,presentable,fulfillment,duration_days,created_at&user_email=eq.${email}&simulated=eq.false&order=created_at.desc&limit=60`
      );
      if (rows.length === 0) {
        rows = await sbSelect<OfferRow>(
          "offers",
          `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,created_at&user_email=eq.${email}&simulated=eq.false&order=created_at.desc&limit=60`
        );
      }
      return rows;
    })(),
  ]);

  // Newest offer per shop only - older rounds are history, not open deals.
  const seen = new Set<string>();
  const now = Date.now();
  const open = [] as Array<{
    vendorId: string;
    vendorName: string;
    pricePerDay: number;
    currency: string;
    round: number;
    verified: boolean;
    fulfillment: string | null;
    durationDays: number | null;
    at: string;
    stale: boolean;
  }>;
  for (const o of offers) {
    const key = o.vendor_id || o.vendor_name || String(o.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!o.price_per_day || o.price_per_day <= 0) continue;
    open.push({
      vendorId: o.vendor_id ?? "",
      vendorName: o.vendor_name ?? "Rental shop",
      pricePerDay: Number(o.price_per_day),
      currency: o.currency ?? "USD",
      round: o.round ?? 0,
      verified: Boolean(o.verified),
      fulfillment: o.fulfillment ?? null,
      durationDays: o.duration_days ?? null,
      at: o.created_at,
      // A quote older than a day may no longer be honoured - flag it honestly.
      stale: now - Date.parse(o.created_at) > 24 * 60 * 60 * 1000,
    });
  }

  return NextResponse.json({ bookings, offers: open.slice(0, 20) });
}
