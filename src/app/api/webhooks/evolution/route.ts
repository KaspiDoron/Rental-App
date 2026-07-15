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

// The region of the last outbound to this shop - primes the voice transcriber
// for the local accent (best-effort; undefined just means no language hint).
async function regionForThread(fromDigits: string): Promise<string | undefined> {
  const rows = await sbSelect<{ raw: { region?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&order=received_at.desc&limit=1`
  ).catch(() => []);
  const r = rows[0]?.raw?.region;
  return typeof r === "string" && r ? r : undefined;
}

function extractText(data: any): string {
  const m = data?.message?.ephemeralMessage?.message ?? data?.message ?? {};
  return (
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    ""
  );
}

// WhatsApp voice notes arrive as audioMessage (audio/ogg; codecs=opus), also
// wrapped in ephemeralMessage on disappearing chats.
function hasAudioMessage(data: any): boolean {
  const m = data?.message?.ephemeralMessage?.message ?? data?.message ?? {};
  return Boolean(m?.audioMessage);
}
function hasImageMessage(data: any): boolean {
  const m = data?.message?.ephemeralMessage?.message ?? data?.message ?? {};
  return Boolean(m?.imageMessage);
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
    const instance = String(body.instance ?? body.instanceName ?? "");

    // Delivery / read receipts (blue tick) feed the Anti-Ban risk engine:
    // a healthy number gets read and replied to; delivered-but-never-read is a
    // strong spam signal, so we track it and let the guard react.
    if (event.includes("messages.update")) {
      try {
        const email = await emailForInstance(instance);
        if (email) {
          const items = Array.isArray(body.data) ? body.data : [body.data];
          const { recordReadReceipt, recordDelivery } = await import("@/lib/wa-guard");
          for (const d of items.slice(0, 20)) {
            const jid = String(d?.key?.remoteJid ?? "");
            if (!d?.key?.fromMe || !jid.endsWith("@s.whatsapp.net")) continue;
            const to = jid.split("@")[0];
            const status = String(d?.update?.status ?? d?.status ?? "").toUpperCase();
            if (status.includes("READ") || status === "4" || status === "5") {
              await recordReadReceipt(email, to);
            } else if (status.includes("DELIVERY") || status === "3") {
              await recordDelivery(email, to);
            }
          }
        }
      } catch {
        /* receipts are best-effort */
      }
      return NextResponse.json({ ok: true });
    }

    // Connection lifecycle. IMPORTANT: a 401 "close" is ALSO emitted as a
    // normal part of the pairing-code handshake (restartRequired), so we must
    // NOT treat every 401 as a ban - that would pause a number the instant it
    // links. Only a genuine loggedOut/conflict reason enters ban-recovery; an
    // "open" refreshes the durable state so the app flips to connected.
    if (event.includes("connection.update")) {
      try {
        const data = Array.isArray(body.data) ? body.data[0] : body.data;
        const state = String(data?.state ?? data?.connection ?? "").toLowerCase();
        const reason = String(
          data?.statusReason ??
            data?.lastDisconnect?.error?.output?.payload?.error ??
            data?.lastDisconnect?.error?.message ??
            ""
        ).toLowerCase();
        const email = await emailForInstance(instance);
        if (state === "open" && email) {
          const { markOpen } = await import("@/lib/evolution");
          markOpen(email).catch(() => {});
        } else if (
          state === "close" &&
          email &&
          /logged.?out|conflict|banned|forbidden|multidevice.?mismatch/.test(reason)
        ) {
          const { enterBanRecovery } = await import("@/lib/wa-guard");
          await enterBanRecovery(email, 24);
        }
      } catch {
        /* best-effort */
      }
      return NextResponse.json({ ok: true });
    }

    if (!event.includes("messages.upsert")) return NextResponse.json({ ok: true });

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
      const hasImage = hasImageMessage(data);
      const hasAudio = hasAudioMessage(data);

      await sbInsert("whatsapp_messages", [
        {
          wa_message_id: msgId,
          from_number: from,
          to_number: instance,
          body: text || (hasImage ? "[photo]" : hasAudio ? "[voice note]" : ""),
          type: hasImage ? "image" : hasAudio ? "audio" : "text",
          direction: "inbound",
          raw: { instance, pushName: data.pushName ?? null, channel: "evolution" },
        },
      ]);
      // Response-time analytics: record how fast this shop replied to our RFQ.
      const { recordResponseTime } = await import("@/lib/stats");
      recordResponseTime(from).catch(() => {});

      // A shop that sends ONLY a price-list photo or a voice note (no caption)
      // is the common case - read the media, don't skip it.
      if (!text && !hasImage && !hasAudio) continue;

      const email = await emailForInstance(instance);
      // A real inbound proves the socket is live: persist "open" durably.
      if (email) {
        const { markOpen } = await import("@/lib/evolution");
        markOpen(email).catch(() => {});
      }

      // Price-list photo? Download it so the vision agent can read the prices.
      const images: { mime: string; base64: string }[] = [];
      if (hasImage && email) {
        const { fetchMediaBase64 } = await import("@/lib/evolution");
        const media = await fetchMediaBase64(email, data);
        if (media) images.push(media);
      }

      // Voice note? Download + transcribe (heavy-accent primed) so the whole
      // pipeline treats it exactly like an inbound text.
      let transcript: { text: string; language?: string; source: string } | null = null;
      if (hasAudio && email && !text) {
        try {
          const { fetchMediaBase64 } = await import("@/lib/evolution");
          const media = await fetchMediaBase64(email, data);
          if (media) {
            const { transcribeAudio } = await import("@/lib/graph/transcribe");
            const rfqRegion = await regionForThread(from);
            transcript = await transcribeAudio({
              mime: media.mime || "audio/ogg",
              base64: media.base64,
              region: rfqRegion,
            });
          }
        } catch {
          /* transcription is best-effort - engine sends a polite fallback */
        }
      }

      await processVendorReply({
        fromDigits: from,
        text,
        images,
        transcript,
        waMessageId: msgId,
        senderEmail: email ?? undefined,
        humanDelay: Boolean(email),
        send: async (to, message) => {
          if (!email) return { ok: false, error: "unknown instance" };
          return sendFromUser(email, to, message);
        },
      });
    }
  } catch {
    // Never fail the webhook.
  }

  // Opportunistic queue drain: any webhook activity flushes due outbox
  // messages (business-hours / pacing queue) AND due graph wakeups (strategic
  // waits + judge jobs) without a dedicated worker.
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    await drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text));
  } catch {
    /* best-effort */
  }
  try {
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text));
  } catch {
    /* best-effort */
  }
  // Quiet sessions whose users have not used the app for a while - the link
  // survives, but the device stops looking permanently active on WhatsApp.
  try {
    const { pauseIdleSessions } = await import("@/lib/evolution");
    pauseIdleSessions().catch(() => {});
  } catch {
    /* best-effort */
  }

  return NextResponse.json({ ok: true });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
