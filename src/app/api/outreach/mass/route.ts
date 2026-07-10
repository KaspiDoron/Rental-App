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
  }

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const results: { id: string; sent: boolean; queued?: boolean; reason?: string }[] = [];
  for (const v of vendors) {
    let to = (v.whatsapp ?? "").trim();
    if (!to && v.placeId) to = (await placeDetails(v.placeId))?.phone ?? "";
    if (!to) {
      results.push({ id: v.id, sent: false, reason: "no-phone" });
      continue;
    }
    const digits = to.replace(/[^\d]/g, "");

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
    };
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text: batchMessage,
      auto: true,
      queueIfBlocked: true,
      region: String(body.region ?? "") || undefined,
      meta,
    });
    if (!guard.allow) {
      results.push({
        id: v.id,
        sent: false,
        queued: Boolean(guard.queuedUntil),
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
            ...(englishGloss ? { englishGloss } : {}),
          },
        },
      ]);
    }
    results.push({ id: v.id, sent: ok, reason: ok ? undefined : reason ?? "not-on-whatsapp" });
  }

  return NextResponse.json({
    results,
    sent: results.filter((r) => r.sent).length,
    queued: results.filter((r) => r.queued).length,
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
