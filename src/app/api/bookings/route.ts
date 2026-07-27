import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect, sbDelete } from "@/lib/runtime-config";

// Persist confirmed bookings and list the caller's booking history.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const b = await req.json().catch(() => null);
  if (!b?.vendorName) {
    return NextResponse.json({ error: "booking payload required" }, { status: 400 });
  }

  // COMMITMENT LOCK: refuse a second confirmed booking with a DIFFERENT shop
  // inside 10 minutes - the double-booking window where two shops both hear
  // "yes". Re-booking the same shop (retry, edit) stays allowed.
  const thisVendorId = String(b.vendorId ?? "");
  const recent = await sbSelect<{ vendor_id: string | null; vendor_name: string }>(
    "bookings",
    `select=vendor_id,vendor_name&user_email=eq.${encodeURIComponent(
      session.email
    )}&status=eq.confirmed&created_at=gte.${encodeURIComponent(
      new Date(Date.now() - 10 * 60_000).toISOString()
    )}&order=created_at.desc&limit=1`
  ).catch(() => []);
  if (
    recent[0] &&
    thisVendorId &&
    recent[0].vendor_id &&
    recent[0].vendor_id !== thisVendorId
  ) {
    return NextResponse.json(
      {
        error: `You just locked a deal with ${recent[0].vendor_name}. To book a different shop, remove that booking first (My deals).`,
        alreadyCommitted: true,
        vendorName: recent[0].vendor_name,
      },
      { status: 409 }
    );
  }

  // TRUST NOTHING NUMERIC FROM THE CLIENT. The daily price and duration define
  // the total; recompute it server-side so a tampered/garbage client total can
  // never be persisted as the money record.
  const pricePerDay = Math.max(0, Number(b.pricePerDay) || 0);
  const durationDays = Math.min(Math.max(Math.floor(Number(b.durationDays) || 1), 1), 90);
  const totalPrice = Math.round(pricePerDay * durationDays);

  // Validate the pickup date/time: a real format, and never in the past
  // (compared in the shop's local wall-clock, which is how it is stored).
  const scheduledAt = typeof b.scheduledAt === "string" ? b.scheduledAt : "";
  if (scheduledAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scheduledAt)) {
    return NextResponse.json({ error: "Invalid pickup date/time." }, { status: 400 });
  }
  // THE RENTAL WINDOW IS DECIDED HERE, BY PLAN.
  //
  // This route had no plan check at all: "free is same-day only" was enforced
  // in the outreach composer and nowhere else, so a client posting a future
  // pickup date simply got one. A rule enforced at one surface out of four is
  // not a rule. lib/rental-window is the single authority every surface calls,
  // including the client - which now only DISPLAYS what the server decided.
  if (scheduledAt) {
    const { resolveWindow } = await import("@/lib/rental-window");
    const decision = resolveWindow({
      plan: session.plan,
      requested: scheduledAt.slice(0, 10),
      nowMs: Date.now(),
      timeZone: typeof b.timeZone === "string" ? b.timeZone : undefined,
    });
    if (decision.adjusted) {
      // ...and it also COUNTS. A free plan posting a future pickup date
      // straight at this endpoint is the least ambiguous bypass evidence the
      // system can observe, and it used to reach the ladder not at all: the
      // server refused the booking and forgot it, so the same traveller could
      // try every hour and never climb a rung. One signal, weighted like any
      // other, decaying like any other - never a verdict on its own.
      const { recordSignal } = await import("@/lib/integrity/store");
      await recordSignal({
        email: session.email,
        plan: session.plan,
        kind: "future-pickup",
        evidence: `booking posted for ${scheduledAt.slice(0, 10)}; plan allows from ${decision.startDate}`,
      }).catch(() => {});
      return NextResponse.json(
        {
          error: decision.reason,
          window: { startDate: decision.startDate, maxStartDate: decision.maxStartDate },
          upgrade: decision.daysAhead === 0,
        },
        { status: 400 }
      );
    }
  }
  // Return date, if given, must be after the pickup date.
  const returnDate = typeof b.returnDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.returnDate) ? b.returnDate : null;
  if (returnDate && scheduledAt && returnDate < scheduledAt.slice(0, 10)) {
    return NextResponse.json({ error: "Return date must be after pickup." }, { status: 400 });
  }

  const fulfillment = ["in-store", "hotel-delivery"].includes(String(b.fulfillment))
    ? String(b.fulfillment)
    : "in-store";

  const bookingBase = {
    user_email: session.email,
    vendor_id: String(b.vendorId ?? ""),
    vendor_name: String(b.vendorName),
    price_per_day: pricePerDay,
    total_price: totalPrice,
    fulfillment,
    scheduled_at: scheduledAt || null,
    status: "confirmed",
  };
  // Extra rental fields - added incrementally, so try the richest insert first
  // and fall back through pending-migration column sets (sbInsert fails
  // silently on an unknown column). A booking must NEVER be lost to a migration.
  const extra = {
    currency: String(b.currency ?? "USD").slice(0, 6),
    duration_days: durationDays,
    return_date: returnDate,
    start_date: scheduledAt ? scheduledAt.slice(0, 10) : null,
    delivery_address: fulfillment === "hotel-delivery" ? String(b.deliveryAddress ?? "").slice(0, 200) || null : null,
    one_way_dropoff: b.oneWayDropOff ? String(b.oneWayDropOff).slice(0, 120) : null,
    driver_age: Number.isFinite(Number(b.driverAge)) ? Math.floor(Number(b.driverAge)) : null,
    scheduled_tz: "shop-local", // scheduled_at is the shop's wall-clock, no offset
  };
  const ok = await sbInsert("bookings", [{ ...bookingBase, ...extra }]);
  if (!ok) {
    const okCur = await sbInsert("bookings", [{ ...bookingBase, currency: extra.currency }]);
    if (!okCur) await sbInsert("bookings", [bookingBase]);
  }
  return NextResponse.json({ ok: true, totalPrice, currency: extra.currency });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const filter = `user_email=eq.${encodeURIComponent(session.email)}&order=created_at.desc&limit=25`;
  let rows = await sbSelect(
    "bookings",
    `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,return_date,delivery_address,driver_age,status,created_at&${filter}`
  );
  if (rows.length === 0) {
    // Pre-migration fallbacks (a select naming an unknown column fails as []).
    rows = await sbSelect(
      "bookings",
      `select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,created_at&${filter}`
    );
  }
  if (rows.length === 0) {
    rows = await sbSelect(
      "bookings",
      `select=id,vendor_name,price_per_day,total_price,fulfillment,scheduled_at,status,created_at&${filter}`
    );
  }
  return NextResponse.json({ bookings: rows });
}

// Remove a past booking from the caller's own history (item #10). Strictly
// scoped to the signed-in user - nobody can delete another user's row.
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  await sbDelete(
    "bookings",
    `id=eq.${id}&user_email=eq.${encodeURIComponent(session.email)}`
  );
  return NextResponse.json({ ok: true });
}
