// Official Meta WhatsApp Cloud API webhook (used when the owner has a
// verified business + Cloud API credentials). Inbound vendor replies are
// persisted and fed into the shared agentic loop (lib/agent-loop.ts) - the
// same pipeline the per-user Evolution sessions use.
//
// GET  - verification handshake. Meta calls this with hub.verify_token; we echo
//        hub.challenge when the token matches WHATSAPP_VERIFY_TOKEN.
// POST - inbound events.
//
// Configure the callback URL in Meta as: https://<your-domain>/api/webhooks/whatsapp

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig, sbInsert } from "@/lib/runtime-config";
import { processVendorReply } from "@/lib/agent-loop";
import { sendWhatsApp } from "@/lib/whatsapp";

// Verify Meta's X-Hub-Signature-256 over the RAW request body. Returns true
// when no app secret is configured (demo/dev) so the endpoint still works,
// but once WHATSAPP_APP_SECRET is set an unsigned or forged POST is rejected -
// closing the "anyone who knows the URL can inject vendor replies" hole.
function signatureValid(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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
  // Read the RAW body once - signature verification must run over the exact
  // bytes Meta signed, so we cannot use req.json() first.
  const raw = await req.text();
  const appSecret = await getConfig("WHATSAPP_APP_SECRET");
  if (appSecret) {
    const sig = req.headers.get("x-hub-signature-256");
    if (!signatureValid(raw, sig, appSecret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!body) return NextResponse.json({ ok: true });

  try {
    const inbound: { id: string; from: string; text?: { body?: string } }[] = [];
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
          if ((msg.type ?? "text") === "text") inbound.push(msg);
        }
      }
    }
    if (rows.length) await sbInsert("whatsapp_messages", rows);

    // Agentic processing (bounded so Meta always gets a fast 200).
    for (const msg of inbound.slice(0, 3)) {
      await processVendorReply({
        fromDigits: msg.from,
        text: msg.text?.body ?? "",
        waMessageId: msg.id,
        send: async (to, message) => {
          const r = await sendWhatsApp(to, message);
          return { ok: r.ok && r.channel === "cloud-api", error: r.error };
        },
      });
    }
  } catch {
    // Never fail the webhook - Meta retries and will disable a flaky endpoint.
  }

  return NextResponse.json({ ok: true });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
