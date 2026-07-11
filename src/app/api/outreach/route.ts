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

  // Free-tier pickup rule: only TODAY pickups are allowed. A free user who is
  // already in a cooldown (from a prior bypass attempt) is blocked entirely;
  // a fresh attempt to arrange a next-day pickup triggers a 6-hour cooldown.
  if (session.plan === "free") {
    const { cooldownLeft, setCooldown, requestsFuturePickup } = await import("@/lib/cooldown");
    const left = await cooldownLeft(session.email, "pickup-bypass");
    if (left > 0) {
      return NextResponse.json({
        allowed: false,
        blocked: true,
        cooldownMinutes: left,
        reason: `Free plan is today-pickup only. Sending is paused for ${Math.ceil(
          left / 60
        )}h after trying to arrange a future-day pickup. Upgrade to schedule future pickups.`,
        upgrade: true,
      });
    }
    if (requestsFuturePickup(message)) {
      await setCooldown(session.email, "pickup-bypass", 360, "free-tier future pickup attempt");
      return NextResponse.json({
        allowed: false,
        blocked: true,
        cooldownMinutes: 360,
        reason:
          "The free plan can only arrange same-day (today) pickups. Scheduling a future pickup needs Pro/Ultra - sending is paused for 6 hours.",
        upgrade: true,
      });
    }
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

  // Anti-Ban gate for agent-composed sends (RFQs, bargains). Custom messages
  // the user typed are auto:false - they skip the engagement halt but still
  // respect volume caps. Blocked-by-hours sends are QUEUED, not lost.
  const kind = String(body.kind ?? "custom");
  const isAuto = kind !== "custom";
  const wantsLocal = Boolean(body.localLang) && session.plan === "ultra";

  let outboundText = message;
  let englishGloss: string | undefined;

  // PER-SHOP MESSAGE VARIETY: the client sends ONE rfq.vendorMessage for the
  // whole search, so every shop was getting the identical first message. For
  // agent RFQs we regenerate a freshly-varied message here (server-side single
  // source of truth), so no two shops ever receive the same opening text.
  if (isAuto && kind === "rfq" && body.rfq) {
    try {
      const { variedFirstMessage } = await import("@/lib/agents");
      outboundText = variedFirstMessage(body.rfq);
    } catch {
      /* keep the client message on any failure */
    }
  }

  // ULTRA local-language: the FIRST message must also be in the shop's own
  // language, not just later bargains (this was the "local language doesn't
  // work" gap - the RFQ always went out in English). Bargain drafts arrive
  // already localized by composeBargain, so only localize agent RFQs here.
  if (wantsLocal && isAuto && kind === "rfq") {
    const { localizeMessage } = await import("@/lib/agents");
    const localized = await localizeMessage(
      outboundText,
      String(body.region ?? "") || undefined,
      session.email
    );
    if (localized.english && localized.text !== outboundText) englishGloss = localized.english;
    outboundText = localized.text;
  }

  // CONNECTION FIRST (same rule as mass outreach): if the user has no WhatsApp
  // channel at all, say exactly that - never queue the message and tell them
  // "the shop is closed" when the real problem is on our side.
  {
    const { evolutionConfigured, wasEverConnected } = await import("@/lib/evolution");
    const { whatsappConfigured } = await import("@/lib/whatsapp");
    const personal =
      (await evolutionConfigured()) && (await wasEverConnected(session.email));
    const cloud = await whatsappConfigured();
    if (!personal && !cloud) {
      return NextResponse.json(
        {
          allowed: true,
          sent: false,
          connect: true,
          error: "Your WhatsApp is not connected - open Profile and link it first.",
        },
        { status: 400 }
      );
    }
  }

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const guard = await guardOutbound({
    senderKey: session.email,
    toDigits: digits,
    text: outboundText,
    auto: isAuto,
    queueIfBlocked: true,
    region: String(body.region ?? "") || undefined,
    // The client passes the shop's live Google "open now" state so the gate
    // agrees with the badge the user sees on the card (fixes false "closed").
    shopOpenNow: typeof body.openNow === "boolean" ? body.openNow : undefined,
    meta: {
      sender: session.email,
      vendorId: String(body.vendorId ?? ""),
      vendorName: String(body.vendorName ?? ""),
      kind,
      round: Number(body.round ?? 0),
      rfq: body.rfq ?? null,
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: Boolean(body.localLang) && session.plan === "ultra",
    },
  });
  if (!guard.allow) {
    const halted =
      (guard.reason ?? "").startsWith("engagement-halt") ||
      (guard.reason ?? "").startsWith("rfq-dedup");
    return NextResponse.json({
      allowed: true,
      sent: false,
      queued: Boolean(guard.queuedUntil),
      queuedUntil: guard.queuedUntil,
      halted,
      error: halted
        ? "This shop was already asked - your agent keeps the existing conversation going instead of re-sending the question."
        : guard.queuedUntil
        ? /closed|business hours/i.test(guard.reason ?? "")
          ? "The shop is closed right now - your message is queued and will be sent when they open."
          : "Queued for a moment - your agent paces messages like a human so your number stays safe."
        : guard.reason,
    });
  }
  const guardedMessage = guard.text;

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

  // Try the user's personal WhatsApp whenever the connector is set up.
  // sendFromUser itself verifies the live session (auto-resuming a dropped
  // one), so we never wrongly tell a connected user to "connect first" just
  // because a bookkeeping row is missing.
  if (await evolutionConfigured()) {
    configured = (await wasEverConnected(session.email)) || false;
    const r = await sendFromUser(session.email, digits, guardedMessage, true);
    if (r.ok || r.error === "reconnecting" || r.rateLimited) configured = true;
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
    const r = await sendWhatsApp(to, guardedMessage);
    result = { channel: r.channel, ok: r.ok, error: r.error };
  }
  if (result.ok) await afterSend(session.email, digits);

  // Log the outbound message WITH thread context (vendor + rfq), so the
  // webhook can match the inbound reply and keep the loop fully in-app.
  await sbInsert("whatsapp_messages", [
    {
      to_number: digits,
      body: guardedMessage,
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
        localLang: wantsLocal,
        // English gloss of a localized message so the traveller can read what
        // their agent sent on their behalf (shown by the card's thread peek).
        ...(englishGloss ? { englishGloss } : {}),
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

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
