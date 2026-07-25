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
import { digitsOnly } from "@/lib/phone";
import { resolveOutreachIdentity } from "@/lib/wa/identity";

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

  // Resolve the destination number server-side. ANTI-SPOOF: when the vendor
  // has a real Google identity (placeId), the client-supplied number must
  // match the resolved one - a mismatched number must NEVER wear a real
  // vendor's name (this is exactly how a test number once impersonated a real
  // Bali shop and leaked a private chat onto its card). The owner may still
  // test against an arbitrary number, but the thread is then re-keyed as an
  // explicit test vendor.
  let to = String(body.to ?? "").trim();
  let vendorIdOverride: string | null = null;
  let vendorNameOverride: string | null = null;
  // IDENTITY VERIFICATION (privacy keystone). A stored outbound row is what
  // later makes an inbound reply attribute to a shop, so a number may ONLY wear
  // a real shop's name+rfq if it is POSITIVELY the shop's own Google-listed
  // phone. This runs for ANY send that claims a real shop - not just when a
  // placeId happens to be present (the old `if (body.placeId)` guard left two
  // holes: no placeId at all, and a placeId whose Google record has no phone -
  // both let an unverifiable personal number keep the real shop's identity and
  // ingest that contact's private chats as "shop replies").
  {
    const claimedId = String(body.vendorId ?? "");
    const claimsRealShop =
      Boolean(body.vendorName || body.vendorId || body.placeId) &&
      !claimedId.startsWith("test-") &&
      !claimedId.startsWith("drill-");
    let resolvedPhone = "";
    if (body.placeId) {
      const details = await placeDetails(String(body.placeId));
      resolvedPhone = digitsOnly(details?.phone);
      if (!digitsOnly(to) && details?.phone) to = details.phone; // fill from Google
    }
    const supplied = digitsOnly(to);
    // The decision is a pure, unit-pinned helper (see wa/identity.ts) - only a
    // POSITIVE phone contradiction or an explicit owner test re-keys to a test
    // identity; the mere absence of a reference phone keeps the real identity.
    // BUG 1B: only re-key to a "(unverified)" test identity when the owner is
    // actually running a DRILL (TEST_MODE on). In production the owner is a real
    // user - their real shops must keep their real names.
    const { testModeOn } = await import("@/lib/allowlist");
    const ownerTestMode = session.role === "owner" && (await testModeOn());
    const identity = resolveOutreachIdentity({
      claimsRealShop,
      resolvedPhone,
      supplied,
      ownerTestMode,
      vendorName: body.vendorName ? String(body.vendorName) : undefined,
    });
    if (identity.action === "send-to-shop") {
      to = `+${identity.toPhone}`;
    } else if (identity.action === "rekey-test") {
      vendorIdOverride = identity.vendorId;
      vendorNameOverride = identity.vendorName;
    }
  }
  if (!to) {
    return NextResponse.json({
      allowed: true,
      sent: false,
      reason: "no-phone",
      note: "No phone number found for this shop yet.",
    });
  }

  const digits = digitsOnly(to);
  // An explicit send from the user RE-OPENS a shop they previously removed
  // from the queue - the tombstone yields only to a fresh human decision.
  {
    const { clearCancellation } = await import("@/lib/wa/cancellations");
    await clearCancellation(session.email, digits).catch(() => {});
  }
  // The identity every stored row uses - a spoofed number can only ever be a
  // clearly-labelled test vendor, never the real shop.
  const vendorId = vendorIdOverride ?? String(body.vendorId ?? "");
  const vendorName = vendorNameOverride ?? String(body.vendorName ?? "");

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
      // Module 4: the deterministic variation-matrix compiler (seed =
      // user|vendor|hour) + the global-uniqueness guard, replacing the old
      // Math.random template pools - reproducible diversity, cross-fleet
      // skeleton dedup (the Redis window no-ops on Vercel).
      const { compileOpener } = await import("@/lib/copy/promptCompiler");
      const { openerSeed } = await import("@/lib/copy/matrix");
      const { regionForShop } = await import("@/lib/copy/region");
      const { ensureGloballyUnique } = await import("@/lib/graph/uniqueness");
      // Region from the SHOP's phone (authoritative), label as fallback.
      const shopRegion = regionForShop(digits, String(body.region ?? ""));
      const compiled = compileOpener(
        body.rfq,
        openerSeed(session.email, vendorId || digits, new Date().toISOString().slice(0, 13)),
        shopRegion
      );
      outboundText = (await ensureGloballyUnique(compiled, [])).text;
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
    const { regionForShop } = await import("@/lib/copy/region");
    const localized = await localizeMessage(
      outboundText,
      regionForShop(digits, String(body.region ?? "")),
      session.email
    );
    if (localized.english && localized.text !== outboundText) englishGloss = localized.english;
    // DOCUMENTED fallback: if localization failed (after its retry), the
    // opener goes out in English and the reason is durably recorded - a
    // language flip is never a silent mystery.
    if (!localized.localized) {
      await sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          vendor_id: vendorId,
          vendor_name: vendorName,
          detail: JSON.stringify({
            email: session.email,
            region: String(body.region ?? ""),
            reason: "AI localization unavailable after retry - sent in English",
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
    outboundText = localized.text;
  }

  // CONNECTION FIRST (same rule as mass outreach): if the user has no WhatsApp
  // channel at all, say exactly that - never queue the message and tell them
  // "the shop is closed" when the real problem is on our side.
  {
    // Gate on EVER-PAIRED (hasSessionRow), NOT the live socket state
    // (wasEverConnected). A transient Evolution-host outage must never tell a
    // linked user to "connect first" - the send path (sendFromUser) already
    // returns an honest "reconnecting" state when the socket is momentarily
    // down. connect:true is reserved for a user who has genuinely never linked.
    const { evolutionConfigured, hasSessionRow } = await import("@/lib/evolution");
    const { whatsappConfigured } = await import("@/lib/whatsapp");
    const personal =
      (await evolutionConfigured()) && (await hasSessionRow(session.email));
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
      vendorId,
      vendorName,
      kind,
      round: Number(body.round ?? 0),
      rfq: body.rfq ?? null,
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: Boolean(body.localLang) && session.plan === "ultra",
      // Carried on the queued outbox row so the card's thread peek can show
      // the English reading of a held local-language message.
      ...(englishGloss ? { englishGloss } : {}),
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
      // The guard's REAL reason - the card renders it honestly (a pacing hold
      // must never be shown as "shop closed").
      queuedReason: guard.queuedUntil ? guard.reason ?? null : null,
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
  let result: { channel: string; ok: boolean; error?: string; rateLimited?: boolean; unconfirmed?: boolean } = {
    channel: "none",
    ok: false,
  };
  let configured = false;

  // ATOMIC SEND SLOTS, claimed BEFORE the network send: two concurrent
  // identical requests (double-tap, retried fetch) can never both deliver -
  // the old dedup row was only written AFTER a successful send, so both
  // passed the pre-flight together. Auto sends also take the pacing slot.
  {
    const { claimForSend } = await import("@/lib/wa-guard");
    const claim = await claimForSend(session.email, digits, guardedMessage, isAuto);
    if (!claim.ok && claim.kind === "duplicate") {
      return NextResponse.json({
        allowed: true,
        sent: false,
        duplicate: true,
        reason: "This exact message is already on its way to the shop.",
      });
    }
    if (!claim.ok) {
      // pacing loss / unknown claim state: park honestly instead of racing.
      const { jitteredHold } = await import("@/lib/wa/pacing");
      const notBefore = jitteredHold(Date.now(), 1, 2);
      await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          body: guardedMessage,
          not_before: notBefore,
          meta: {
            sender: session.email,
            vendorId,
            vendorName,
            kind,
            reason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
          },
        },
      ]).catch(() => {});
      return NextResponse.json({
        allowed: true,
        sent: false,
        queued: true,
        queuedUntil: notBefore,
        queuedReason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
      });
    }
  }

  // Try the user's personal WhatsApp whenever the connector is set up.
  // sendFromUser itself verifies the live session (auto-resuming a dropped
  // one), so we never wrongly tell a connected user to "connect first" just
  // because a bookkeeping row is missing.
  if (await evolutionConfigured()) {
    configured = (await wasEverConnected(session.email)) || false;
    const r = await sendFromUser(session.email, digits, guardedMessage, true);
    if (r.ok || r.error === "reconnecting" || r.rateLimited) configured = true;
    result = { channel: "personal-wa", ok: r.ok, error: r.error, rateLimited: r.rateLimited, unconfirmed: r.unconfirmed };
    if (r.rateLimited) {
      const { releaseSendClaim } = await import("@/lib/wa-guard");
      await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
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
      const { releaseSendClaim } = await import("@/lib/wa-guard");
      await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
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
  if (result.ok) {
    await afterSend(session.email, digits);
  } else {
    // Failed send: release the idempotency claim so the user's retry tap is
    // not swallowed as a "duplicate" of the failure.
    const { releaseSendClaim } = await import("@/lib/wa-guard");
    await releaseSendClaim(session.email, digits, guardedMessage).catch(() => {});
  }

  // TRUTH RULE: the outbound whatsapp_messages row is the record every
  // surface (thread peek, activity feed, deals dashboard, contacted counts)
  // treats as "a message reached this shop". A FAILED send must therefore
  // never write one - it used to (raw.ok:false), which made the UI count
  // shops as contacted when nothing was delivered.
  if (result.ok) {
    // Log the outbound message WITH thread context (vendor + rfq), so the
    // webhook can match the inbound reply and keep the loop fully in-app.
    await sbInsert("whatsapp_messages", [
      {
        to_number: digits,
        body: guardedMessage,
        type: "text",
        direction: "outbound",
        raw: {
          channel: result.channel,
          sender: session.email,
          ok: true,
          // false when Evolution accepted the request but returned no delivery
          // receipt - the card shows "sent, unverified" instead of a checkmark.
          confirmed: result.unconfirmed ? false : true,
          vendorId,
          vendorName,
          kind: String(body.kind ?? "custom"),
          round: Number(body.round ?? 0),
          rfq: body.rfq ?? null,
          region: String(body.region ?? ""),
          plan: session.plan,
          localLang: wantsLocal,
          // English gloss of a localized message so the traveller can read
          // what their agent sent on their behalf (card thread peek).
          ...(englishGloss ? { englishGloss } : {}),
        },
      },
    ]);
  } else {
    // Keep the failure observable without polluting the "sent" record.
    await sbInsert("agent_events", [
      {
        kind: "send-failed",
        vendor_id: vendorId,
        vendor_name: vendorName,
        detail: JSON.stringify({
          email: session.email,
          channel: result.channel,
          error: result.error ?? "unknown",
        }).slice(0, 800),
      },
    ]).catch(() => {});
  }

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
