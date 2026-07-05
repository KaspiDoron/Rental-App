import { NextResponse } from "next/server";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  wasEverConnected,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";

// In-app outreach: the ONLY way messages leave the app. The user never jumps
// to WhatsApp - we screen the message through the safety agent, resolve the
// shop's number server-side (Place Details) when needed, send via the official
// WhatsApp Cloud API, and log the full thread context so the webhook can match
// the shop's reply back to this conversation automatically.
//
// Body: { to?, placeId?, vendorId?, vendorName?, message, kind?, rfq?, round? }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to message vendors." }, { status: 401 });
  }
  const { killSwitchOn } = await import("@/lib/usage");
  if (await killSwitchOn()) {
    return NextResponse.json(
      { error: "WheelDeal is temporarily paused by the owner." },
      { status: 503 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { allowed: false, reason: verdict.reason, suggestion: verdict.suggestion },
      { status: 200 }
    );
  }

  // Resolve the destination number server-side.
  let to = String(body.to ?? "").trim();
  if (!to && body.placeId) {
    const details = await placeDetails(String(body.placeId));
    to = details?.phone ?? "";
  }
  if (!to) {
    return NextResponse.json({
      allowed: true,
      sent: false,
      reason: "no-phone",
      note: "No phone number found for this shop yet.",
    });
  }

  const digits = to.replace(/[^\d]/g, "");

  // Channel priority:
  //   1. The user's OWN WhatsApp (Evolution QR session) - the most authentic
  //      sender a bargain can have, with strict anti-ban rate limits.
  //   2. The official Meta Cloud API (owner-level business number).
  //   3. Neither connected -> the UI falls back to copy-paste, still in-app.
  let result: { channel: string; ok: boolean; error?: string; rateLimited?: boolean } = {
    channel: "none",
    ok: false,
  };
  let configured = false;

  // Try the user's personal WhatsApp whenever the connector is set up and they
  // have paired before - sendFromUser auto-resumes a dropped session, so a
  // transient Render restart no longer forces "connect again".
  if ((await evolutionConfigured()) && (await wasEverConnected(session.email))) {
    configured = true;
    const r = await sendFromUser(session.email, digits, message);
    result = { channel: "personal-wa", ok: r.ok, error: r.error, rateLimited: r.rateLimited };
    if (r.rateLimited) {
      return NextResponse.json({
        allowed: true,
        sent: false,
        configured: true,
        channel: "personal-wa",
        rateLimited: true,
        error: r.error,
      });
    }
    if (r.error === "reconnecting") {
      return NextResponse.json({
        allowed: true,
        sent: false,
        configured: true,
        channel: "personal-wa",
        reconnecting: true,
        error:
          "Your WhatsApp is reconnecting (the server was waking up). Wait a few seconds and tap again - no need to re-link.",
      });
    }
  }
  if (!result.ok && (await whatsappConfigured())) {
    configured = true;
    const r = await sendWhatsApp(to, message);
    result = { channel: r.channel, ok: r.ok, error: r.error };
  }

  // Log the outbound message WITH thread context (vendor + rfq), so the
  // webhook can match the inbound reply and keep the loop fully in-app.
  await sbInsert("whatsapp_messages", [
    {
      to_number: digits,
      body: message,
      type: "text",
      direction: "outbound",
      raw: {
        channel: configured ? result.channel : "unconfigured",
        sender: session.email,
        ok: result.ok,
        vendorId: String(body.vendorId ?? ""),
        vendorName: String(body.vendorName ?? ""),
        kind: String(body.kind ?? "custom"),
        round: Number(body.round ?? 0),
        rfq: body.rfq ?? null,
        region: String(body.region ?? ""),
        plan: session.plan,
      },
    },
  ]);

  return NextResponse.json({
    allowed: true,
    sent: configured && result.ok,
    configured,
    channel: configured ? result.channel : "unconfigured",
    error: result.error,
    phone: to,
  });
}
