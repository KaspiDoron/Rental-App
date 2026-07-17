import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  wasEverConnected,
  ensureConnected,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { sbInsert } from "@/lib/runtime-config";
import { killSwitchOn } from "@/lib/usage";
import { can } from "@/lib/entitlements";

// Mass bargain (Pro/Ultra): fire the RFQ at several shops in one tap. The
// anti-ban rate limiter still governs every single send - the batch simply
// stops when the budget runs out (the UI shows how many actually went).
//
// BETA LIMIT: each search session contacts at most 10 rental shops in total
// (sent + queued), enforced HERE - the UI cap is a courtesy, this is the
// truth. Raised automatically in a future update once scaling lands.
const MAX_BATCH = 10;
const SESSION_SHOP_CAP = 10;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!can(session.plan, "mass-bargain")) {
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
  let vendors: {
    id: string;
    name: string;
    whatsapp?: string;
    placeId?: string;
    openNow?: boolean; // Google "open now" - the same truth the card shows
  }[] = Array.isArray(body.vendors) ? body.vendors.slice(0, MAX_BATCH) : [];
  if (!message || vendors.length === 0) {
    return NextResponse.json({ error: "message and vendors required" }, { status: 400 });
  }

  // Per-SESSION cap (backend truth, cannot be bypassed by repeat taps): count
  // the distinct shops already contacted or queued since this search session
  // started, and only allow the remainder. The session boundary is the user's
  // latest `searches` row - the same signal the deals dashboard groups by.
  try {
    const { sbSelect } = await import("@/lib/runtime-config");
    const enc = encodeURIComponent(session.email);
    const lastSearch = await sbSelect<{ created_at: string }>(
      "searches",
      `select=created_at&user_email=eq.${enc}&order=created_at.desc&limit=1`
    );
    const sinceIso = lastSearch[0]?.created_at ?? new Date(Date.now() - 86400000).toISOString();
    const [sentRows, queuedRows] = await Promise.all([
      sbSelect<{ to_number: string }>(
        "whatsapp_messages",
        `select=to_number&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover)&received_at=gte.${sinceIso}&limit=200`
      ).catch(() => []),
      sbSelect<{ to_number: string }>(
        "wa_outbox",
        `select=to_number&sender_key=eq.${enc}&limit=50`
      ).catch(() => []),
    ]);
    const contacted = new Set([
      ...sentRows.map((r) => r.to_number),
      ...queuedRows.map((r) => r.to_number),
    ]);
    const allowance = Math.max(0, SESSION_SHOP_CAP - contacted.size);
    if (allowance === 0) {
      return NextResponse.json({
        results: [],
        sent: 0,
        queued: 0,
        capReached: true,
        cap: SESSION_SHOP_CAP,
        error: `This search already reached its ${SESSION_SHOP_CAP}-shop beta limit - replies from the contacted shops keep flowing in.`,
      });
    }
    vendors = vendors.slice(0, allowance);
  } catch {
    /* cap check is best-effort - the MAX_BATCH slice still bounds the run */
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json({ error: verdict.reason ?? "Blocked." }, { status: 400 });
  }

  const personal =
    (await evolutionConfigured()) && (await wasEverConnected(session.email));
  const cloud = await whatsappConfigured();
  if (!personal && !cloud) {
    return NextResponse.json({ error: "Connect your WhatsApp first.", connect: true }, { status: 400 });
  }
  // Resume a dropped session before the batch (best-effort).
  if (personal) await ensureConnected(session.email, 6000);

  // ULTRA local-language: localize the batch message ONCE up front (the guard
  // then varies it per shop). English fallback if the AI is unavailable.
  let batchMessage = message;
  let englishGloss: string | undefined;
  if (Boolean(body.localLang) && session.plan === "ultra") {
    const { localizeMessage } = await import("@/lib/agents");
    const localized = await localizeMessage(message, String(body.region ?? "") || undefined);
    batchMessage = localized.text;
    if (localized.english && localized.text !== message) englishGloss = localized.english;
    if (!localized.localized) {
      // Documented English fallback (after retry) - never a silent flip.
      await sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          vendor_id: "",
          vendor_name: "(mass bargain)",
          detail: JSON.stringify({
            email: session.email,
            region: String(body.region ?? ""),
            reason: "AI localization unavailable after retry - batch sent in English",
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
  }

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const results: {
    id: string;
    sent: boolean;
    queued?: boolean;
    queuedUntil?: string;
    queuedReason?: string;
    reason?: string;
    text?: string;
    gloss?: string;
  }[] = [];
  for (const v of vendors) {
    let to = (v.whatsapp ?? "").trim();
    if (!to && v.placeId) to = (await placeDetails(v.placeId))?.phone ?? "";
    if (!to) {
      results.push({ id: v.id, sent: false, reason: "no-phone" });
      continue;
    }
    const digits = to.replace(/[^\d]/g, "");
    // The user explicitly selected this shop for the mass run - that decision
    // re-opens a previously removed/cancelled recipient.
    {
      const { clearCancellation } = await import("@/lib/wa/cancellations");
      await clearCancellation(session.email, digits).catch(() => {});
    }

    // EVERY mass send passes the anti-ban gate: identical text blasted to 6
    // shops in a burst is a textbook spam signature. The gate varies the
    // payload PER SHOP, respects hours/caps, and queues instead of dropping.
    const meta = {
      sender: session.email,
      vendorId: v.id,
      vendorName: v.name,
      kind: "rfq",
      round: 0,
      rfq: body.rfq ?? null,
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: Boolean(body.localLang) && session.plan === "ultra",
      // On queued rows the thread peek reads the gloss from outbox meta.
      ...(englishGloss ? { englishGloss } : {}),
    };
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text: batchMessage,
      auto: true,
      queueIfBlocked: true,
      region: String(body.region ?? "") || undefined,
      // Google truth first: an open shop is NEVER queued as "closed". Only
      // when openNow is unknown does the local-clock window apply.
      shopOpenNow: typeof v.openNow === "boolean" ? v.openNow : undefined,
      meta,
    });
    if (!guard.allow) {
      results.push({
        id: v.id,
        sent: false,
        queued: Boolean(guard.queuedUntil),
        queuedUntil: guard.queuedUntil ? new Date(guard.queuedUntil).toISOString() : undefined,
        // Raw guard reason so the card can explain the hold honestly.
        queuedReason: guard.queuedUntil ? guard.reason ?? undefined : undefined,
        reason: guard.queuedUntil ? "queued" : guard.reason,
      });
      continue;
    }

    let ok = false;
    let reason: string | undefined;
    if (personal) {
      const r = await sendFromUser(session.email, digits, guard.text);
      ok = r.ok;
      reason = r.error;
      if (r.rateLimited) {
        results.push({ id: v.id, sent: false, reason: "rate-limit" });
        break; // budget exhausted - stop the batch quietly
      }
    } else if (cloud) {
      const r = await sendWhatsApp(to, guard.text);
      ok = r.ok && r.channel === "cloud-api";
      reason = r.error;
    }
    if (ok) {
      await afterSend(session.email, digits);
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: guard.text,
          type: "text",
          direction: "outbound",
          raw: {
            channel: personal ? "personal-wa" : "cloud-api",
            ok: true,
            ...meta,
          },
        },
      ]);
    }
    results.push({
      id: v.id,
      sent: ok,
      reason: ok ? undefined : reason ?? "not-on-whatsapp",
      // Give the traveller the EXACT text we sent + its faithful English gloss
      // so the status panel shows what really went out (never a paraphrase).
      text: ok ? guard.text : undefined,
      gloss: ok ? englishGloss : undefined,
    });
  }

  return NextResponse.json({
    results,
    sent: results.filter((r) => r.sent).length,
    queued: results.filter((r) => r.queued).length,
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
