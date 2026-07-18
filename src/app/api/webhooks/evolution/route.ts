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
// message is stored/processed ONLY if it comes from a number THIS USER's agent
// first messaged as a rental-shop thread - scoped to the receiving instance's
// owner, so one user's test thread can never open another user's (or the
// owner's own) private chats to ingestion. Drill/test threads (the owner
// rehearsing against a friend's number) count for 12 HOURS only: when the
// drill is over, the friend's private messages stop being ingested.
// Shared with wa-sync so BOTH ingestion paths enforce the same gate (a
// second copy is how the drill window got skipped on the recovery path).
import { isVendorThread } from "@/lib/drill";
import { digitsOnly } from "@/lib/phone";

// The region of the last outbound to this shop - primes the voice transcriber
// for the local accent (best-effort; undefined just means no language hint).
// Scoped to the receiving user: another user's region must never prime it.
async function regionForThread(fromDigits: string, ownerEmail: string): Promise<string | undefined> {
  const rows = await sbSelect<{ raw: { region?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&raw->>sender=eq.${encodeURIComponent(ownerEmail)}&order=received_at.desc&limit=1`
  ).catch(() => []);
  const r = rows[0]?.raw?.region;
  return typeof r === "string" && r ? r : undefined;
}

function unwrap(data: any): any {
  return data?.message?.ephemeralMessage?.message ?? data?.message ?? {};
}

function extractText(data: any): string {
  const m = unwrap(data);
  return (
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    m?.documentMessage?.caption ??
    m?.videoMessage?.caption ??
    ""
  );
}

// WhatsApp voice notes arrive as audioMessage (audio/ogg; codecs=opus), also
// wrapped in ephemeralMessage on disappearing chats.
function hasAudioMessage(data: any): boolean {
  return Boolean(unwrap(data)?.audioMessage);
}
function hasImageMessage(data: any): boolean {
  return Boolean(unwrap(data)?.imageMessage);
}
// Beyond image/audio: documents (PDF rate cards), location pins and contact
// cards used to be silently dropped - now every one becomes either engine
// input or an honest user-facing note.
function documentMessage(data: any): { mimetype?: string; fileName?: string } | null {
  const d = unwrap(data)?.documentMessage;
  return d ? { mimetype: d.mimetype, fileName: d.fileName } : null;
}
function locationMessage(data: any): { lat?: number; lng?: number; name?: string } | null {
  const l = unwrap(data)?.locationMessage;
  return l
    ? { lat: Number(l.degreesLatitude), lng: Number(l.degreesLongitude), name: l.name || l.address }
    : null;
}
function contactMessage(data: any): { name?: string; digits?: string } | null {
  const c = unwrap(data)?.contactMessage ?? unwrap(data)?.contactsArrayMessage?.contacts?.[0];
  if (!c) return null;
  const digits = String(c.vcard ?? "").match(/waid=(\d{6,})|TEL[^:]*:\+?([\d\s-]{6,})/i);
  return {
    name: c.displayName ?? undefined,
    digits: digitsOnly(digits?.[1] ?? digits?.[2]) || undefined,
  };
}

// Media downloads fail transiently (host mid-restart, expired media). A
// price-list photo silently lost = a lost offer, so retry with backoff.
async function fetchMediaWithRetry(
  email: string,
  data: any
): Promise<{ mime: string; base64: string } | null> {
  const { fetchMediaBase64 } = await import("@/lib/evolution");
  const delays = [0, 2000, 5000];
  for (const wait of delays) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const media = await fetchMediaBase64(email, data);
      if (media) return media;
    } catch {
      /* retry */
    }
  }
  return null;
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
      if (!data?.key) continue;
      const remoteJid = String(data.key.remoteJid ?? "");
      if (!remoteJid.endsWith("@s.whatsapp.net")) continue; // skip groups/status
      const from = remoteJid.split("@")[0];

      // Resolve the RECEIVING user FIRST - every store/read below is scoped to
      // them. An unresolvable instance is never ingested (a receiver-less row
      // would be unscopeable forever).
      const email = await emailForInstance(instance);
      if (!email) {
        await sbInsert("agent_events", [
          {
            kind: "webhook-orphan",
            vendor_id: "",
            vendor_name: from,
            detail: `Inbound from +${from} on unknown Evolution instance "${instance}" - dropped (privacy: cannot attribute a receiver).`,
          },
        ]).catch(() => {});
        continue;
      }

      // Not a rental-shop thread THIS user opened? Drop it - never stored,
      // never read. (Applies to fromMe too: private chats stay sacred, and a
      // finished drill stops ingesting the friend's messages after 12h.)
      if (!(await isVendorThread(from, email))) continue;

      // ---- HUMAN TAKEOVER DETECTION ------------------------------------------
      // A fromMe message in a shop thread is either (a) our own bot send
      // echoing back, or (b) THE USER typing in WhatsApp themselves. Case (b)
      // used to be invisible - the agent kept talking over the user. Now it
      // stores the message and stands the agents down for this thread.
      if (data.key.fromMe) {
        try {
          const { getConfig } = await import("@/lib/runtime-config");
          if ((await getConfig("HUMAN_TAKEOVER"))?.toLowerCase() === "off") continue;
          const text = extractText(data);
          if (!text.trim()) continue; // media-only self message - out of scope
          const msgId = String(data.key.id ?? "");
          const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
          // Echo check 1: a bot send is already recorded with this provider id.
          const byId = msgId
            ? await sbSelect(
                "whatsapp_messages",
                `select=id&direction=eq.outbound&to_number=eq.${encodeURIComponent(
                  from
                )}&wa_message_id=eq.${encodeURIComponent(msgId)}&limit=1`
              )
            : [];
          if (byId.length > 0) continue;
          // Echo check 2: same body already stored as OUR outbound recently
          // (every bot/app send is inserted at send time).
          const recentOut = await sbSelect<{ body: string | null }>(
            "whatsapp_messages",
            `select=body&direction=eq.outbound&to_number=eq.${encodeURIComponent(
              from
            )}&raw->>sender=eq.${encodeURIComponent(email)}&received_at=gte.${encodeURIComponent(
              new Date(Date.now() - 10 * 60_000).toISOString()
            )}&order=received_at.desc&limit=10`
          );
          const isEcho = recentOut.some(
            (m) => (m.body ?? "").replace(/\s+/g, " ").trim().toLowerCase() === normalized
          );
          if (isEcho) continue;
          // A real human message: record it in the thread + stand down.
          await sbInsert("whatsapp_messages", [
            {
              wa_message_id: msgId || null,
              from_number: instance,
              to_number: from,
              body: text,
              type: "text",
              direction: "outbound",
              raw: { sender: email, kind: "human-manual", channel: "evolution" },
            },
          ]);
          const { setThreadTakeover } = await import("@/lib/session-flags");
          const already = await (await import("@/lib/session-flags")).isThreadTakenOver(email, from);
          if (!already) {
            await setThreadTakeover(email, from, true);
            // The human is at the wheel NOW - kill anything already scheduled
            // for this thread so the agent cannot talk over them: pending
            // outbox rows AND strategic-wait wakeups. (The guard also refuses
            // takeover sends as a belt; this removes the queue itself.)
            const { sbDelete } = await import("@/lib/runtime-config");
            await sbDelete(
              "wa_outbox",
              `sender_key=eq.${encodeURIComponent(email)}&to_number=eq.${encodeURIComponent(from)}`
            ).catch(() => {});
            await sbDelete(
              "graph_wakeups",
              `kind=eq.tick&thread_key=eq.${encodeURIComponent(`${email}:${from}`)}`
            ).catch(() => {});
            const { sendPushToUser } = await import("@/lib/push");
            sendPushToUser(email, {
              title: "You've got the wheel 🤝",
              body: "You messaged this shop yourself - Will is standing down on that chat until you hand it back (open the conversation in the app).",
              url: "/",
            }).catch(() => {});
          }
        } catch {
          /* takeover detection is best-effort - never break the webhook */
        }
        continue;
      }

      const text = extractText(data);
      const msgId = String(data.key.id ?? "");
      const hasImage = hasImageMessage(data);
      const hasAudio = hasAudioMessage(data);
      const doc = documentMessage(data);
      const loc = locationMessage(data);
      const contact = contactMessage(data);

      // Location pins / contact cards become plain text the engine can use.
      let syntheticText = text;
      if (!syntheticText && loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
        syntheticText = `(the shop shared its location${loc.name ? `: ${loc.name}` : ""} - https://maps.google.com/?q=${loc.lat},${loc.lng})`;
      }
      if (!syntheticText && contact && (contact.name || contact.digits)) {
        syntheticText = `(the shop shared a contact${contact.name ? `: ${contact.name}` : ""}${contact.digits ? ` +${contact.digits}` : ""})`;
      }

      await sbInsert("whatsapp_messages", [
        {
          wa_message_id: msgId,
          from_number: from,
          to_number: instance,
          body:
            syntheticText ||
            (hasImage
              ? "[photo]"
              : hasAudio
              ? "[voice note]"
              : doc
              ? `[document: ${doc.fileName ?? "file"}]`
              : ""),
          type: hasImage ? "image" : hasAudio ? "audio" : doc ? "document" : "text",
          direction: "inbound",
          // receiver = the ONE user whose WhatsApp got this message. Every
          // read surface filters on it - the privacy isolation keystone.
          raw: { instance, receiver: email, pushName: data.pushName ?? null, channel: "evolution" },
        },
      ]);
      // Response-time analytics: record how fast this shop replied to our RFQ.
      const { recordResponseTime } = await import("@/lib/stats");
      recordResponseTime(from).catch(() => {});

      // A real inbound proves the socket is live: persist "open" durably.
      {
        const { markOpen } = await import("@/lib/evolution");
        markOpen(email).catch(() => {});
      }

      // A PDF (or any non-image document) can't go through the vision agent -
      // tell the user honestly instead of dropping it on the floor.
      const docIsImage = Boolean(doc?.mimetype && /^image\//i.test(doc.mimetype));
      if (doc && !docIsImage && email) {
        const { sendPushToUser } = await import("@/lib/push");
        sendPushToUser(email, {
          title: "A shop sent a document 📄",
          body: `${doc.fileName ?? "A file"} arrived on WhatsApp - open the chat there to view it.`,
          url: "/",
        }).catch(() => {});
        await sbInsert("agent_events", [
          {
            kind: "media-unreadable",
            vendor_id: "",
            vendor_name: from,
            detail: `Document "${doc.fileName ?? "file"}" (${doc.mimetype ?? "?"}) from +${from} - stored, not machine-readable (email ${email}).`,
          },
        ]).catch(() => {});
      }

      // A shop that sends ONLY a price-list photo or a voice note (no caption)
      // is the common case - read the media, don't skip it.
      if (!syntheticText && !hasImage && !hasAudio && !docIsImage) continue;

      // Price-list photo (or image-typed document)? Download WITH RETRY so the
      // vision agent can read the prices - a transient media failure must not
      // lose the offer.
      const images: { mime: string; base64: string }[] = [];
      if ((hasImage || docIsImage) && email) {
        const media = await fetchMediaWithRetry(email, data);
        if (media) images.push(media);
        else if (!syntheticText) {
          // Total failure with no caption: be honest, don't go silent.
          const { sendPushToUser } = await import("@/lib/push");
          sendPushToUser(email, {
            title: "A photo didn't come through 📷",
            body: "A shop sent a photo we couldn't download - check the chat in WhatsApp.",
            url: "/",
          }).catch(() => {});
          await sbInsert("agent_events", [
            {
              kind: "media-fetch-failed",
              vendor_id: "",
              vendor_name: from,
              detail: `Photo from +${from} failed to download after 3 attempts (email ${email}).`,
            },
          ]).catch(() => {});
          continue;
        }
      }

      // Voice note? Download + transcribe (heavy-accent primed) so the whole
      // pipeline treats it exactly like an inbound text.
      let transcript: { text: string; language?: string; source: string } | null = null;
      if (hasAudio && email && !syntheticText) {
        try {
          const media = await fetchMediaWithRetry(email, data);
          if (media) {
            const { transcribeAudio } = await import("@/lib/graph/transcribe");
            const rfqRegion = await regionForThread(from, email);
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
        remoteJid, // true origin chat - asserted against `from` before attributing
        text: syntheticText,
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

  // FAST COUNTER-REPLY: the agent's reply we just composed is parked ~10-40s in
  // the future, so the drain above (rows due NOW) cannot send it, and waiting for
  // the next 60s cron would blow the ~2 min ceiling. Kick the self-chaining tick:
  // it claims a single-runner slot and, because the reply is due within its 45s
  // in-call budget, WAITS in-process until due and drains it - delivering the
  // counter-message within ~its human-delay, app open or closed. The 30s chain
  // claim collapses many concurrent inbound webhooks to one runner (no herd).
  fetch(`${url.origin}/api/wa/tick?token=${encodeURIComponent(expected)}&hop=0`).catch(() => {});
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
