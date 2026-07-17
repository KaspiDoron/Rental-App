import { NextResponse } from "next/server";
import { composeBargain, runSafety, currencyForRegion } from "@/lib/agents";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import type { Vendor, StructuredRFQ } from "@/lib/types";

// Adaptive Bargaining Agent: composes the next negotiation message to send.
// This is the SAME brain the automatic funnel uses - market-floor anchored
// target, cross-shop rival leverage from the user's own session, and the real
// thread history so it never re-asks something the shop already answered.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  // Local-language street bargaining is an Ultra perk (management included).
  const wantsLocal = body.language === "local";
  const isUltra = session.plan === "ultra";
  if (wantsLocal && !isUltra) {
    return NextResponse.json(
      {
        error: "Bargaining in the shop's local language is an Ultra feature.",
        upgrade: true,
      },
      { status: 403 }
    );
  }

  const rfq = body.rfq as StructuredRFQ;
  const vendor = body.vendor as Vendor;
  const region: string | undefined = body.region || undefined;
  const quoted: number | undefined = body.currentPricePerDay;
  const cur = currencyForRegion(region) || "USD";

  // Market floor: the same anchor the automatic agent uses, so the manual
  // Bargain button never proposes a weak or absurd number.
  let floorPrice: number | undefined;
  try {
    const { floorPriceFor } = await import("@/lib/market");
    const floor = await floorPriceFor(region, rfq);
    if (floor && floor.currency === cur) floorPrice = floor.floor;
  } catch {
    /* floor is an enhancement, never a blocker */
  }

  // Cross-shop leverage: the user's best OTHER offer for the same vehicle in
  // this session (client hint accepted, server data preferred).
  let rival: number | undefined = body.rivalPricePerDay;
  try {
    if (quoted) {
      const { vehicleKeyFor } = await import("@/lib/market");
      const vkey = vehicleKeyFor(rfq);
      const since = new Date(Date.now() - 18 * 3600_000).toISOString();
      const rows = await sbSelect<{ price_per_day: number }>(
        "offers",
        `select=price_per_day&user_email=eq.${encodeURIComponent(
          session.email
        )}&simulated=eq.false&currency=eq.${encodeURIComponent(
          cur
        )}&vehicle_key=eq.${encodeURIComponent(vkey)}&vendor_id=neq.${encodeURIComponent(
          String(vendor.id ?? "")
        )}&price_per_day=lt.${quoted}&created_at=gte.${encodeURIComponent(
          since
        )}&order=price_per_day.asc&limit=1`
      );
      if (rows[0]?.price_per_day) rival = Math.min(rival ?? Infinity, rows[0].price_per_day);
      if (!Number.isFinite(rival ?? Infinity)) rival = undefined;
    }
  } catch {
    /* leverage is an enhancement */
  }

  // Thread history: what we and the shop already said - the draft must never
  // repeat an answered question. PRIVACY: vendorId is a Google place id SHARED
  // across users, so both directions are filtered to THIS user (outbound by
  // sender, inbound by receiver) - never another user's thread.
  let history: string | undefined;
  try {
    const digits = String(vendor.whatsapp ?? "").replace(/[^\d]/g, "");
    const out = await sbSelect<{
      direction: string;
      body: string | null;
      raw: { sender?: string; receiver?: string } | null;
    }>(
      "whatsapp_messages",
      `select=direction,body,raw&or=(raw->>vendorId.eq.${encodeURIComponent(
        String(vendor.id ?? "")
      )},from_number.eq.${encodeURIComponent(digits || "none")})&order=received_at.desc&limit=20`
    );
    const mine = out.filter((m) =>
      m.direction === "inbound"
        ? m.raw?.receiver === session.email
        : m.raw?.sender === session.email
    );
    if (mine.length) {
      history = mine
        .slice(0, 10)
        .reverse()
        .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 250)}`)
        .join("\n");
    }
  } catch {
    /* history is an enhancement */
  }

  // Target: aim at (or just under) the rival when we have one, floor-clamped.
  const target =
    quoted !== undefined
      ? Math.max(
          floorPrice ?? 0,
          rival ? Math.min(Math.round(quoted * 0.85), rival) : Math.round(quoted * 0.85)
        )
      : undefined;

  const draft = await composeBargain({
    rfq,
    vendor,
    currentPricePerDay: quoted,
    rivalPricePerDay: rival,
    region,
    round: Math.max(0, Number(body.round ?? 0)),
    currency: cur,
    localLanguage: wantsLocal && isUltra,
    targetPricePerDay: target,
    floorPricePerDay: floorPrice,
    history,
    voiceKey: session.email,
  });

  // Safety-screen even our own composed drafts before they can be sent.
  const verdict = await runSafety(draft.message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Draft failed the safety screen - try again." },
      { status: 500 }
    );
  }

  await sbInsert("bargain_drafts", [
    {
      user_email: session.email,
      vendor_id: String(vendor.id ?? ""),
      tactic: draft.tacticId,
      message: draft.message,
    },
  ]);

  return NextResponse.json(draft);
}

// Vercel: allow slow AI upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
