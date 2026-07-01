// Official Meta WhatsApp Cloud API webhook.
//
// GET  - verification handshake. Meta calls this with hub.verify_token; we echo
//        hub.challenge when the token matches WHATSAPP_VERIFY_TOKEN.
// POST - inbound events. We persist vendor replies to Supabase (whatsapp_messages)
//        so the Bargaining agents can pick up and continue negotiations.
//
// Configure the callback URL in Meta as: https://<your-domain>/api/webhooks/whatsapp

import { NextResponse } from "next/server";
import { getConfig, sbInsert } from "@/lib/runtime-config";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = await getConfig("WHATSAPP_VERIFY_TOKEN");
  if (mode === "subscribe" && expected && token === expected) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

interface WaValue {
  metadata?: { phone_number_id?: string };
  messages?: {
    id: string;
    from: string;
    timestamp?: string;
    text?: { body?: string };
    type?: string;
  }[];
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: true });

  try {
    const rows: Record<string, unknown>[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value as WaValue;
        for (const msg of value.messages ?? []) {
          rows.push({
            wa_message_id: msg.id,
            from_number: msg.from,
            to_number: value.metadata?.phone_number_id ?? null,
            body: msg.text?.body ?? "",
            type: msg.type ?? "text",
            direction: "inbound",
            raw: msg,
          });
        }
      }
    }
    if (rows.length) await sbInsert("whatsapp_messages", rows);
  } catch {
    // Never fail the webhook - Meta retries and will disable a flaky endpoint.
  }

  // Meta requires a fast 200 acknowledgement.
  return NextResponse.json({ ok: true });
}
