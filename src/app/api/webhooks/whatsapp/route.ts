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

interface WaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}
interface WaMessage {
  id: string;
  from: string;
  timestamp?: string;
  text?: { body?: string };
  image?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
  type?: string;
}
interface WaValue {
  metadata?: { phone_number_id?: string };
  messages?: WaMessage[];
}

// Download an inbound Cloud API media object as base64 (two-step Graph API
// flow: media-id -> temporary URL -> bytes). Best-effort; returns null on any
// failure so a photo never breaks the webhook. Enables photo understanding on
// the official channel too, not just Evolution.
async function fetchCloudMedia(
  mediaId: string
): Promise<{ mime: string; base64: string } | null> {
  const token = await getConfig("WHATSAPP_ACCESS_TOKEN");
  if (!token) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();
    if (!meta?.url) return null;
    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!binRes.ok) return null;
    const buf = Buffer.from(await binRes.arrayBuffer());
    return { mime: meta.mime_type || "image/jpeg", base64: buf.toString("base64") };
  } catch {
    return null;
  }
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
    const inbound: WaMessage[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value as WaValue;
        for (const msg of value.messages ?? []) {
          const kind = msg.type ?? "text";
          const caption = msg.image?.caption ?? msg.document?.caption;
          rows.push({
            wa_message_id: msg.id,
            from_number: msg.from,
            to_number: value.metadata?.phone_number_id ?? null,
            body:
              msg.text?.body ??
              caption ??
              (kind === "image" ? "[photo]" : kind === "audio" ? "[voice note]" : ""),
            type: kind,
            direction: "inbound",
            raw: msg,
          });
          // Text, image/document AND voice notes are processed (a shop that
          // replies with a price-list photo or an audio price must be understood).
          if (kind === "text" || kind === "image" || kind === "document" || kind === "audio") {
            inbound.push(msg);
          }
        }
      }
    }
    if (rows.length) await sbInsert("whatsapp_messages", rows);

    // Agentic processing (bounded so Meta always gets a fast 200).
    for (const msg of inbound.slice(0, 3)) {
      const media = msg.image ?? msg.document;
      const images =
        media?.id && (media.mime_type ?? "").startsWith("image/")
          ? await fetchCloudMedia(media.id).then((m) => (m ? [m] : []))
          : [];
      // Voice note? Download + transcribe (heavy-accent primed).
      let transcript: { text: string; language?: string; source: string } | null = null;
      const txt = msg.text?.body ?? media?.caption ?? "";
      if (msg.audio?.id && !txt) {
        const audio = await fetchCloudMedia(msg.audio.id);
        if (audio) {
          const { transcribeAudio } = await import("@/lib/graph/transcribe");
          transcript = await transcribeAudio({
            mime: audio.mime || "audio/ogg",
            base64: audio.base64,
          });
        }
      }
      await processVendorReply({
        fromDigits: msg.from,
        text: txt,
        waMessageId: msg.id,
        images,
        transcript,
        send: async (to, message) => {
          const r = await sendWhatsApp(to, message);
          return { ok: r.ok && r.channel === "cloud-api", error: r.error };
        },
      });
    }
    // Drain due graph wakeups (strategic waits + judge jobs) opportunistically.
    try {
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await drainGraphWakeups(async (_s, to, message) => {
        const r = await sendWhatsApp(to, message);
        return { ok: r.ok && r.channel === "cloud-api", error: r.error };
      });
    } catch {
      /* best-effort */
    }
  } catch {
    // Never fail the webhook - Meta retries and will disable a flaky endpoint.
  }

  return NextResponse.json({ ok: true });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
