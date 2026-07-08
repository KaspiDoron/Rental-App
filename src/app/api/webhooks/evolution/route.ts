// Evolution API webhook - inbound messages from users' personal WhatsApp
// sessions (QR-connected in Profile). Feeds the same agentic loop as the
// official Cloud API webhook; auto-replies go back out through the SAME
// user's session, so the whole conversation stays authentic and in-app.
//
// The webhook URL we register includes ?token=<derived-from-api-key>, so
// random internet traffic cannot inject fake vendor replies.

import { NextResponse } from "next/server";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import { processVendorReply } from "@/lib/agent-loop";
import {
  webhookToken,
  emailForInstance,
  sendFromUser,
} from "@/lib/evolution";

// PRIVACY HARD RULE: WheelDeal must NEVER read a user's personal chats. A
// message is stored/processed ONLY if it comes from a number WE first messaged
// as a rental-shop thread (an outbound row exists for it). Anything else -
// friends, family, groups, statuses - is dropped on the spot, unstored.
async function isVendorThread(fromDigits: string): Promise<boolean> {
  const rows = await sbSelect(
    "whatsapp_messages",
    `select=id&direction=eq.outbound&to_number=eq.${encodeURIComponent(fromDigits)}&limit=1`
  );
  return rows.length > 0;
}

function extractText(data: any): string {
  return (
    data?.message?.conversation ??
    data?.message?.extendedTextMessage?.text ??
    data?.message?.imageMessage?.caption ??
    ""
  );
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const expected = await webhookToken();
  if (!expected || url.searchParams.get("token") !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: true });

  try {
    const event = String(body.event ?? "").toLowerCase().replace(/_/g, ".");
    if (!event.includes("messages.upsert")) return NextResponse.json({ ok: true });

    const instance = String(body.instance ?? body.instanceName ?? "");
    const items = Array.isArray(body.data) ? body.data : [body.data];

    for (const data of items.slice(0, 3)) {
      if (!data?.key || data.key.fromMe) continue; // only the vendor's messages
      const remoteJid = String(data.key.remoteJid ?? "");
      if (!remoteJid.endsWith("@s.whatsapp.net")) continue; // skip groups/status
      const from = remoteJid.split("@")[0];

      // Not a rental-shop thread we opened? Drop it - never stored, never read.
      if (!(await isVendorThread(from))) continue;

      const text = extractText(data);
      const msgId = String(data.key.id ?? "");

      await sbInsert("whatsapp_messages", [
        {
          wa_message_id: msgId,
          from_number: from,
          to_number: instance,
          body: text,
          type: "text",
          direction: "inbound",
          raw: { instance, pushName: data.pushName ?? null, channel: "evolution" },
        },
      ]);
      // Response-time analytics: record how fast this shop replied to our RFQ.
      const { recordResponseTime } = await import("@/lib/stats");
      recordResponseTime(from).catch(() => {});

      if (!text) continue;

      const email = await emailForInstance(instance);
      await processVendorReply({
        fromDigits: from,
        text,
        waMessageId: msgId,
        send: async (to, message) => {
          if (!email) return { ok: false, error: "unknown instance" };
          return sendFromUser(email, to, message);
        },
      });
    }
  } catch {
    // Never fail the webhook.
  }

  return NextResponse.json({ ok: true });
}
