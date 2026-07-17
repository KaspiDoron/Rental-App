import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import { digitsOnly } from "@/lib/phone";

// LIVE DRILL (management only): run the REAL pipeline against a real phone
// number that is NOT a rental shop - a friend plays the shop on WhatsApp.
// The opener goes out through the exact production path (profiler ->
// varied message -> optional localization -> anti-ban guard -> the admin's
// own WhatsApp), and every reply the "shop" sends flows through the standard
// webhook into the real agents. The truest possible end-to-end rehearsal.

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "Drill Shop").slice(0, 60);
  const digits = digitsOnly(String(body.phone ?? ""));
  const text = String(body.text ?? "").trim();
  const region = String(body.region ?? "").trim() || undefined;
  const wantsLocal = Boolean(body.localLang);
  if (digits.length < 7) {
    return NextResponse.json({ error: "Enter a full phone number with country code." }, { status: 400 });
  }
  if (text.length < 5) {
    return NextResponse.json({ error: "Describe the rental request (a sentence is enough)." }, { status: 400 });
  }

  const vendorId = `drill-${digits}`;

  // The REAL production chain, end to end.
  const { runProfiler, variedFirstMessage, localizeMessage } = await import("@/lib/agents");
  const rfq = await runProfiler(text, undefined, session.email);
  let outboundText = variedFirstMessage(rfq);
  let englishGloss: string | undefined;
  if (wantsLocal && region) {
    const localized = await localizeMessage(outboundText, region, session.email);
    if (localized.english && localized.text !== outboundText) englishGloss = localized.english;
    outboundText = localized.text;
  }

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const guard = await guardOutbound({
    senderKey: session.email,
    toDigits: digits,
    text: outboundText,
    auto: true,
    queueIfBlocked: true,
    region,
    // A friend's number is "open" around the clock - never queue for hours.
    shopOpenNow: true,
    meta: {
      sender: session.email,
      vendorId,
      vendorName: name,
      kind: "rfq",
      round: 0,
      rfq,
      region: region ?? "",
      plan: session.plan,
      localLang: wantsLocal,
      drill: true,
      ...(englishGloss ? { englishGloss } : {}),
    },
  });
  if (!guard.allow) {
    return NextResponse.json({
      sent: false,
      queued: Boolean(guard.queuedUntil),
      queuedUntil: guard.queuedUntil,
      vendorId,
      error: guard.queuedUntil
        ? "Held by the pacing engine - it sends automatically in a moment."
        : guard.reason,
    });
  }

  const { sendFromUser } = await import("@/lib/evolution");
  const r = await sendFromUser(session.email, digits, guard.text, true);
  if (!r.ok) {
    return NextResponse.json({
      sent: false,
      vendorId,
      error: r.error ?? "Send failed - is your WhatsApp connected?",
    });
  }
  await afterSend(session.email, digits);
  await sbInsert("whatsapp_messages", [
    {
      to_number: digits,
      body: guard.text,
      type: "text",
      direction: "outbound",
      raw: {
        channel: "personal-wa",
        ok: true,
        sender: session.email,
        vendorId,
        vendorName: name,
        kind: "rfq",
        round: 0,
        rfq,
        region: region ?? "",
        plan: session.plan,
        localLang: wantsLocal,
        drill: true,
        ...(englishGloss ? { englishGloss } : {}),
      },
    },
  ]);

  return NextResponse.json({
    sent: true,
    vendorId,
    text: guard.text,
    gloss: englishGloss,
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
