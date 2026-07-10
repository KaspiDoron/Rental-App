import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect } from "@/lib/runtime-config";

// Persist confirmed bookings and list the caller's booking history.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const b = await req.json().catch(() => null);
  if (!b?.vendorName) {
    return NextResponse.json({ error: "booking payload required" }, { status: 400 });
  }
  const bookingBase = {
    user_email: session.email,
    vendor_id: String(b.vendorId ?? ""),
    vendor_name: String(b.vendorName),
    price_per_day: Number(b.pricePerDay ?? 0),
    total_price: Number(b.totalPrice ?? 0),
    fulfillment: String(b.fulfillment ?? "in-store"),
    scheduled_at: b.scheduledAt ?? null,
    status: "confirmed",
  };
  // A booking must NEVER be lost to a pending schema migration: retry without
  // the newest column when the full insert is rejected (sbInsert fails silently).
  const ok = await sbInsert("bookings", [
    { ...bookingBase, currency: String(b.currency ?? "USD").slice(0, 6) },
  ]);
  if (!ok) await sbInsert("bookings", [bookingBase]);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const filter = `user_email=eq.${encodeURIComponent(session.email)}&order=created_at.desc&limit=25`;
  let rows = await sbSelect(
    "bookings",
    `select=vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&${filter}`
  );
  if (rows.length === 0) {
    // Pre-migration fallback (a select naming an unknown column fails as []).
    rows = await sbSelect(
      "bookings",
      `select=vendor_name,price_per_day,total_price,fulfillment,scheduled_at,status,created_at&${filter}`
    );
  }
  return NextResponse.json({ bookings: rows });
}
