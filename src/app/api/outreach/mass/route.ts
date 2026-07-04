import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  connectionState,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { sbInsert } from "@/lib/runtime-config";
import { killSwitchOn } from "@/lib/usage";

// Mass bargain (Pro/Ultra): fire the RFQ at several shops in one tap. The
// anti-ban rate limiter still governs every single send - the batch simply
// stops when the budget runs out (the UI shows how many actually went).
const MAX_BATCH = 6;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (session.plan === "free") {
    return NextResponse.json(
      { error: "Mass bargain is a Pro/Ultra feature.", upgrade: true },
      { status: 403 }
    );
  }
  if (await killSwitchOn()) {
    return NextResponse.json({ error: "Temporarily paused by the owner." }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  const vendors: { id: string; name: string; whatsapp?: string; placeId?: string }[] =
    Array.isArray(body.vendors) ? body.vendors.slice(0, MAX_BATCH) : [];
  if (!message || vendors.length === 0) {
    return NextResponse.json({ error: "message and vendors required" }, { status: 400 });
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json({ error: verdict.reason ?? "Blocked." }, { status: 400 });
  }

  const personal =
    (await evolutionConfigured()) && (await connectionState(session.email)) === "open";
  const cloud = await whatsappConfigured();
  if (!personal && !cloud) {
    return NextResponse.json({ error: "Connect your WhatsApp first.", connect: true }, { status: 400 });
  }

  const results: { id: string; sent: boolean; reason?: string }[] = [];
  for (const v of vendors) {
    let to = (v.whatsapp ?? "").trim();
    if (!to && v.placeId) to = (await placeDetails(v.placeId))?.phone ?? "";
    if (!to) {
      results.push({ id: v.id, sent: false, reason: "no-phone" });
      continue;
    }
    const digits = to.replace(/[^\d]/g, "");
    let ok = false;
    let reason: string | undefined;
    if (personal) {
      const r = await sendFromUser(session.email, digits, message);
      ok = r.ok;
      reason = r.error;
      if (r.rateLimited) {
        results.push({ id: v.id, sent: false, reason: "rate-limit" });
        break; // budget exhausted - stop the batch quietly
      }
    } else if (cloud) {
      const r = await sendWhatsApp(to, message);
      ok = r.ok && r.channel === "cloud-api";
      reason = r.error;
    }
    if (ok) {
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: message,
          type: "text",
          direction: "outbound",
          raw: {
            channel: personal ? "personal-wa" : "cloud-api",
            sender: session.email,
            ok: true,
            vendorId: v.id,
            vendorName: v.name,
            kind: "rfq",
            round: 0,
            rfq: body.rfq ?? null,
            region: String(body.region ?? ""),
            plan: session.plan,
          },
        },
      ]);
    }
    results.push({ id: v.id, sent: ok, reason: ok ? undefined : reason ?? "not-on-whatsapp" });
  }

  return NextResponse.json({ results, sent: results.filter((r) => r.sent).length });
}
