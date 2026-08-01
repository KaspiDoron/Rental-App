// Evolution webhook INGESTION - the runtime-agnostic core of the inbound
// pipeline, extracted from the Next.js route so it has exactly two callers:
//   1. the legacy Next route (src/app/api/webhooks/evolution/route.ts), and
//   2. the BullMQ incoming.worker (services/workers), where the gateway acks
//      the webhook in <200ms and this function runs OFF the request path with
//      retries + DLQ semantics.
// Token verification stays with the callers (each transport authenticates its
// own ingress); everything from event parsing to processVendorReply + the
// opportunistic drains lives here, byte-identical to the route it came from.

import { sbInsert, sbSelect } from "@/lib/runtime-config";
import { processVendorReply } from "@/lib/agent-loop";
import {
  emailForInstance,
  sendFromUser,
} from "@/lib/evolution";
import { noteInboundDropped } from "@/lib/wa/webhook-trace";

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
import { waDigits, numberFilter, waIdKind, lidKey } from "@/lib/wa/phone-key";
import { resolveChatIdentity } from "@/lib/wa/lid-alias";
import { claimInboundStore } from "@/lib/wa/inbound-claim";
import { kickDispatcher } from "@/lib/wa/kick";
import { finishBeforeResponse } from "@/lib/after";
import { parseInboundCoords, describeShopLocation, distanceNote } from "@/lib/wa/inbound-location";

// The region of the last outbound to this shop - primes the voice transcriber
// for the local accent (best-effort; undefined just means no language hint).
// Scoped to the receiving user: another user's region must never prime it.
async function regionForThread(fromDigits: string, ownerEmail: string): Promise<string | undefined> {
  const rows = await sbSelect<{ raw: { region?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      ownerEmail
    )}&order=received_at.desc&limit=1${numberFilter("to_number", fromDigits)}`
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
// A VIDEO WITH NO CAPTION USED TO BE NOTHING AT ALL.
//
// extractText already reads videoMessage.caption, but nothing detected the
// video itself - so "here is the scooter running", sent with no words, stored
// as an empty-bodied row, hit the no-text-no-media check below and was dropped
// with no reply and no placeholder in the transcript. To the traveller the shop
// had sent something and the agent had ignored it; to the agent nothing had
// happened. Same class as the price-list photo, and a shop filming the bike is
// usually a shop that wants to do business.
function hasVideoMessage(data: any): boolean {
  return Boolean(unwrap(data)?.videoMessage);
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

/** A request to run the image turn through the isolated vision pipeline
 * (Module 3): the caller-injected enqueue creates a BullMQ Flow whose CHILD
 * does the heavy download + OCR at strict concurrency and whose PARENT
 * continuation composes the reply (or the never-silent clarify). */
export interface VisionFlowRequest {
  waMessageId: string;
  fromDigits: string;
  remoteJid: string;
  senderEmail: string;
  caption: string;
  /** The single provider message frame (carries the media keys). */
  raw: unknown;
}

/**
 * Process one Evolution webhook payload end-to-end: receipts, connection
 * lifecycle, privacy-gated message ingestion, takeover detection, media +
 * voice handling, the agent turn (processVendorReply) and the opportunistic
 * drains. Never throws for business reasons - only genuinely transient
 * infrastructure errors propagate (so a queue caller can retry with backoff).
 *
 * opts.origin + opts.token: when set (the Next route), the self-chaining
 * /api/wa/tick kick fires as before. The worker passes neither - it IS the
 * persistent process, so the in-request tick chain is unnecessary there.
 *
 * opts.enqueueVisionFlow: injected ONLY by the worker runtime (dependency
 * inversion - this file must never import BullMQ into the Next bundle). When
 * present, image turns are OFFLOADED to the vision Flow instead of running
 * the download + LLM OCR inline in this turn.
 */
export async function processEvolutionWebhook(
  payload: unknown,
  opts: {
    origin?: string;
    token?: string;
    enqueueVisionFlow?: (req: VisionFlowRequest) => Promise<void>;
  } = {}
): Promise<{ retryable: boolean }> {
  const body: any = payload ?? null;
  // Set when a message could not be ingested because OUR OWN storage was
  // unreachable (not because it was judged not-ours). The webhook route
  // answers non-2xx so the provider REDELIVERS - failing loud instead of
  // eating a possibly-genuine shop reply on our own outage.
  let retryable = false;
  // Every user whose thread moved in THIS webhook batch. Their reply
  // dispatcher is kicked at the end - per sender, so one traveller's cold
  // batch can never gate another's answer.
  const touchedSenders = new Set<string>();
  if (!body) return { retryable };

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
      return { retryable };
    }

    // A SHOP IS RINGING THE TRAVELLER'S PHONE.
    //
    // The CALL event was never subscribed to, so this arrived nowhere: the ring
    // reached a traveller who may be on airplane mode, out of local credit, or
    // simply unable to negotiate a rental in spoken Thai - and what the shop
    // experienced was a customer who had stopped answering. Handled in its own
    // module because the privacy gate, the push and the reply all matter and
    // none of them belong inline in this dispatcher.
    //
    // AWAITED, like every other side effect here: Cloud Run freezes the CPU the
    // instant the response flushes, and a detached push about a ringing phone
    // would be the definition of too late.
    if (event.includes("call")) {
      try {
        const email = await emailForInstance(instance);
        const { handleCallEvent } = await import("./call-intercept");
        await finishBeforeResponse("inbound-call", () => handleCallEvent({ email, data: body.data }));
      } catch {
        /* a call we could not read is not a reason to fail the webhook */
      }
      return { retryable };
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
          // THE AGENT IS BLOCKED, and only they can unblock it.
          //
          // Every push this app sent described PROGRESS - a reply, a price, a
          // deal. So the one state that genuinely needs a human, where the
          // link has dropped and nothing will send or arrive until they
          // re-pair, was the one state that produced silence. A hunt could sit
          // dead for hours behind a phone showing "Alerts on".
          await finishBeforeResponse("wa-disconnected-push", async () => {
            try {
              const { worthAnInterruption } = await import("@/lib/notify/significance");
              const { notifyState, markPushSent } = await import("@/lib/notify/state");
              const g = worthAnInterruption({ kind: "agent-blocked" }, await notifyState(email));
              if (!g.notify) return;
              const { sendPushToUser } = await import("@/lib/push");
              await sendPushToUser(email, {
                title: "WhatsApp disconnected 🔌",
                body: "Your agents are paused until you reconnect - open the app and scan the code to pick the hunt back up.",
                url: "/profile",
                // Its own lane: a connection problem must never be collapsed
                // away by an ordinary reply push.
                tag: "wa:disconnected",
              });
              await markPushSent(email, `agent-blocked: ${g.reason}`);
            } catch {
              /* a notification never blocks the webhook */
            }
          });
        }
      } catch {
        /* best-effort */
      }
      return { retryable };
    }

    if (!event.includes("messages.upsert")) return { retryable };

    const items = Array.isArray(body.data) ? body.data : [body.data];

    // Bounded, never SILENTLY truncated: the old slice(0, 3) discarded the
    // 4th+ frame of a batched upsert with no trace of any kind - a shop
    // sending four quick messages lost one invisibly.
    const capped = items.slice(0, 10);
    if (items.length > capped.length) {
      void noteInboundDropped(undefined, "batch", "batch-truncated", {
        via: "webhook",
        total: items.length,
        kept: capped.length,
      });
    }
    for (const data of capped) {
      // Per-item isolation (audit DEFECT 5): a throw handling ONE message in a
      // multi-message webhook batch must not drop its siblings - the route always
      // returns 200, so Evolution never redelivers them. Contain each item.
      try {
      if (!data?.key) continue;
      const remoteJid = String(data.key.remoteJid ?? "");
      const jidKind = waIdKind(remoteJid);
      // Groups, status broadcasts and anything unnameable are never a shop.
      if (jidKind !== "phone" && jidKind !== "lid") continue;

      // Resolve the RECEIVING user FIRST - every store/read below is scoped to
      // them, and a privacy-JID alias is only evidence inside ONE inbox. An
      // unresolvable instance is never ingested (a receiver-less row would be
      // unscopeable forever).
      const email = await emailForInstance(instance);
      if (!email) {
        await sbInsert("agent_events", [
          {
            kind: "webhook-orphan",
            vendor_id: "",
            vendor_name: waDigits(remoteJid) || remoteJid,
            detail: `Inbound from ${remoteJid} on unknown Evolution instance "${instance}" - dropped (privacy: cannot attribute a receiver).`,
          },
        ]).catch(() => {});
        continue;
      }
      touchedSenders.add(email);

      // ONE identity for this chat. A phone JID resolves to its digits (waDigits,
      // NOT a raw split: a multi-device JID carries a device suffix "…:12", and
      // splitting on "@" alone kept it, producing a routing key that matched NO
      // outbound anchor). A privacy @lid chat carries no phone of its own and is
      // resolved only from evidence - see wa/lid-alias. No evidence => dropped,
      // never guessed.
      const identity = await resolveChatIdentity(email, remoteJid, data).catch(() => null);
      const from = identity?.phone ?? "";
      if (!from) {
        // The trace carries the LID as a structured field (not only as the
        // digits slot) so the WA doctor can match it - an @lid drop used to
        // be invisible to the very tool built to find it.
        void noteInboundDropped(email, lidKey(remoteJid) || remoteJid, "unresolved-identity", {
          via: "webhook",
          jid: remoteJid.slice(0, 48),
          lid: lidKey(remoteJid),
        });
        continue;
      }
      const chatLid = identity?.lid ?? "";
      // Downstream asserts the origin chat against the number we attribute to.
      // For a resolved @lid chat that assertion is satisfied by the RESOLVED
      // line, with the privacy id carried alongside for the trace.
      const originJid = jidKind === "phone" ? remoteJid : `${from}@s.whatsapp.net`;

      // Not a rental-shop thread THIS user opened? Drop it - never stored,
      // never read. (Applies to fromMe too: private chats stay sacred, and a
      // finished drill stops ingesting the friend's messages after 12h.)
      // STRICT: null means the thread store was unreachable - the truth is
      // UNKNOWN, and eating a possibly-genuine shop reply on our own outage
      // used to be a permanent loss (the route answered 200, so the provider
      // never redelivered). Fail loud instead: mark the whole delivery
      // retryable and let the webhook answer non-2xx.
      const gate = await isVendorThread(from, email);
      if (gate === null) {
        retryable = true;
        void noteInboundDropped(email, from, "vendor-gate-unavailable", { via: "webhook" });
        continue;
      }
      if (!gate) {
        // Formerly a fully silent drop. Leave a throttled trace so a genuine
        // shop reply lost to a missing RFQ anchor is diagnosable (WA doctor).
        void noteInboundDropped(email, from, "vendor-gate", { via: "webhook" });
        continue;
      }

      // ---- HUMAN TAKEOVER DETECTION ------------------------------------------
      // A fromMe message in a shop thread is either (a) our own bot send
      // echoing back, or (b) THE USER typing in WhatsApp themselves. Case (b)
      // used to be invisible - the agent kept talking over the user. Now it
      // stores the message and stands the agents down for this thread.
      if (data.key.fromMe) {
        try {
          const { getConfig } = await import("@/lib/runtime-config");
          const { parseFlag } = await import("@/lib/config-flags");
          if (!parseFlag(await getConfig("HUMAN_TAKEOVER"), true)) continue;
          const text = extractText(data);
          if (!text.trim()) continue; // media-only self message - out of scope
          const msgId = String(data.key.id ?? "");
          const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
          // Echo check 1: a bot send is already recorded with this provider id.
          // TOLERANT number matching on BOTH echo checks. With an exact
          // `to_number=eq.` a shop stored under a national spelling never
          // matched, so our OWN send echoed back was misread as a human
          // takeover: the agent stood down permanently and wrote an rfq-less
          // row on top of the thread. Same variants the resolver uses.
          const numFilter = numberFilter("to_number", from);
          const byId = msgId
            ? await sbSelect(
                "whatsapp_messages",
                `select=id&direction=eq.outbound&wa_message_id=eq.${encodeURIComponent(
                  msgId
                )}&limit=1${numFilter}`
              )
            : [];
          if (byId.length > 0) continue;
          // Echo check 2: same body already stored as OUR outbound recently
          // (every bot/app send is inserted at send time).
          const recentOut = await sbSelect<{ body: string | null }>(
            "whatsapp_messages",
            `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
              email
            )}&received_at=gte.${encodeURIComponent(
              new Date(Date.now() - 10 * 60_000).toISOString()
            )}&order=received_at.desc&limit=10${numFilter}`
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
              raw: {
                sender: email,
                kind: "human-manual",
                channel: "evolution",
                ...(chatLid ? { lid: chatLid } : {}),
              },
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
              `sender_key=eq.${encodeURIComponent(email)}${numberFilter("to_number", from)}`
            ).catch(() => {});
            await sbDelete(
              "graph_wakeups",
              `kind=eq.tick&thread_key=eq.${encodeURIComponent(`${email}:${from}`)}`
            ).catch(() => {});
            // Through the ONE door, and recorded. A takeover always passes -
            // it is a handover, exempt from the budget - but going around the
            // gate is how a ceiling stops being a ceiling.
            const { worthAnInterruption } = await import("@/lib/notify/significance");
            const { notifyState, markPushSent } = await import("@/lib/notify/state");
            const g = worthAnInterruption({ kind: "takeover" }, await notifyState(email));
            if (g.notify) {
              const { sendPushToUser } = await import("@/lib/push");
              await sendPushToUser(email, {
                title: "You've got the wheel 🤝",
                body: "You messaged this shop yourself - Will is standing down on that chat until you hand it back (open the conversation in the app).",
                url: "/",
              }).catch(() => {});
              await markPushSent(email, `takeover: ${g.reason}`);
            }
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
      const hasVideo = hasVideoMessage(data);
      const doc = documentMessage(data);
      const loc = locationMessage(data);
      const contact = contactMessage(data);

      // Location pins / contact cards become plain text the engine can use. A
      // pin (or a Maps link/coords pasted as chat text) is enriched with the
      // distance to the traveller's stay - so the agent can reason about
      // delivery feasibility - WHEN the traveller consented to share their
      // location (getUserStay masks coords without consent; we only ever surface
      // a rough distance, never their pin).
      let syntheticText = text;
      const pinLoc =
        loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
          ? { lat: loc.lat as number, lng: loc.lng as number, name: loc.name }
          : null;
      const textCoords = syntheticText ? parseInboundCoords(syntheticText) : null;
      if (pinLoc || textCoords) {
        const { getUserStay } = await import("@/lib/access");
        const s = await getUserStay(email).catch(() => null);
        const stayCoords = s ? { lat: s.lat, lng: s.lng } : null;
        if (!syntheticText && pinLoc) {
          syntheticText = describeShopLocation(pinLoc, stayCoords);
        } else if (syntheticText && textCoords) {
          const note = distanceNote(textCoords, stayCoords);
          if (note) syntheticText = `${syntheticText}${note}`;
        }
      }
      if (!syntheticText && contact && (contact.name || contact.digits)) {
        syntheticText = `(the shop shared a contact${contact.name ? `: ${contact.name}` : ""}${contact.digits ? ` +${contact.digits}` : ""})`;
      }

      // IDEMPOTENT STORE. Evolution redelivers (and the recovery sync pulls the
      // same message), and this insert used to be unconditional - so ONE photo
      // became two "[photo]" rows a minute apart in the transcript. Claim the
      // provider message id first; only the winner writes the row. Redis/BullMQ
      // dedupe layers only exist on the worker path, so on the serverless path
      // this claim is the ONLY thing standing between a retry and a duplicate.
      if (msgId && !(await claimInboundStore(msgId))) {
        // A lost claim means another worker already stored this exact frame -
        // normal on redelivery, but traced so a dedup bug can never eat
        // messages invisibly again.
        void noteInboundDropped(email, from, "store-claim-lost", { via: "webhook", msgId });
        continue;
      }
      const stored = await sbInsert("whatsapp_messages", [
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
              : hasVideo
              ? "[video]"
              : doc
              ? `[document: ${doc.fileName ?? "file"}]`
              : ""),
          type: hasImage
            ? "image"
            : hasAudio
            ? "audio"
            : hasVideo
            ? "video"
            : doc
            ? "document"
            : pinLoc
            ? "location"
            : contact
            ? "contact"
            : "text",
          direction: "inbound",
          // receiver = the ONE user whose WhatsApp got this message. Every
          // read surface filters on it - the privacy isolation keystone.
          raw: {
            instance,
            receiver: email,
            pushName: data.pushName ?? null,
            channel: "evolution",
            // The privacy identifier this chat is addressed by, when it is one.
            // Persisting it here (existing JSONB, no migration) is what lets a
            // later @lid frame with no phone field resolve to the same shop
            // after a process restart.
            ...(chatLid ? { lid: chatLid } : {}),
            // What the shop actually SENT, so "Full conversation" can show it
            // instead of the string "[photo]". Bytes are never stored here -
            // only the provider KEY, which /api/wa/media redeems on demand.
            ...(hasImage || hasAudio || doc
              ? {
                  media: {
                    key: data.key ?? null,
                    kind: hasImage ? "image" : hasAudio ? "audio" : "document",
                    mime: doc?.mimetype ?? null,
                    fileName: doc?.fileName ?? null,
                  },
                }
              : {}),
            // A dropped pin is the shop's own address - it belongs in the
            // transcript as a map link, not as prose the traveller cannot tap.
            ...(pinLoc ? { location: { lat: pinLoc.lat, lng: pinLoc.lng, name: pinLoc.name ?? null } } : {}),
            ...(contact && (contact.name || contact.digits)
              ? { contact: { name: contact.name ?? null, digits: contact.digits ?? null } }
              : {}),
          },
        },
      ]);
      if (!stored) {
        // The claim was taken but the row never landed: release the claim so
        // a redelivery can store it, mark the delivery retryable, and trace.
        // Before this check, a failed insert left the message permanently
        // absent while the claim made every retry a silent no-op.
        if (msgId) {
          const { releaseInboundStore } = await import("@/lib/wa/inbound-claim");
          await releaseInboundStore(msgId).catch(() => {});
        }
        retryable = true;
        void noteInboundDropped(email, from, "store-failed", { via: "webhook", msgId });
        continue;
      }
      // Response-time analytics: record how fast this shop replied to our RFQ.
      const { recordResponseTime } = await import("@/lib/stats");
      recordResponseTime(from).catch(() => {});

      // NOTIFY AT INGEST, BUT ONLY WHEN IT IS WORTH IT.
      //
      // Two true things pull against each other here, and this is where they
      // are reconciled.
      //
      // The first: the agent turn is the WRONG place to decide alone. It fires
      // at the end of a successful turn, so every path that never reaches that
      // line - a parked reply, a vision offload, a takeover, a guard refusal,
      // an LLM outage - produced no notification at all. That is most of why
      // the field test showed "Alerts on" and a silent phone. The message is
      // already stored right here, and that fact depends on nothing
      // downstream.
      //
      // The second: `worthAnInterruption` exists precisely because "a shop
      // replied" is not news. This site used to push UNCONDITIONALLY, which
      // undid the policy it was written beside - fifteen shops, fifteen
      // buzzes, most of them auto-greetings.
      //
      // So: the same gate, fed by the PURE detectors already available at
      // ingest - no LLM, no extraction, nothing that can fail or stall. If it
      // carries a price, terms, or nothing at all, the gate knows which and
      // decides. The agent turn still upgrades a price later under the same
      // collapse tag, replacing this on the lock screen rather than adding a
      // second buzz.
      if (email) {
        await finishBeforeResponse("ingest-push", async () => {
          try {
            const body = syntheticText || "";
            const { extractQuotedPrices } = await import("@/lib/wa/price-extract");
            const { classifyActs } = await import("@/lib/wa/dialogue-acts");
            const quoted = body ? extractQuotedPrices(body).offer?.pricePerDay : undefined;
            const acts = classifyActs({ text: body, hadImage: hasImage, pricePerDay: quoted ?? null });
            const { classifyReply, worthAnInterruption } = await import("@/lib/notify/significance");
            const { notifyState, markPushSent } = await import("@/lib/notify/state");
            const state = await notifyState(email);
            const event = classifyReply({
              pricePerDay: quoted,
              anyReplyYet: state.anyReplyYet,
              // The shop stating what it wants held is a fact the traveller
              // acts on - find an ATM, decide about the passport. A photo we
              // have not read yet is not: the agent turn will push if it
              // turns out to carry a price.
              termsLanded: acts.shared.includes("deposit"),
            });
            const verdict = worthAnInterruption(event, state);
            const { sbInsert } = await import("@/lib/runtime-config");
            if (!verdict.notify) {
              // STILL A BREADCRUMB. The doctor's question is "did the last
              // reply push, and if not why" - and "we decided not to" is an
              // answer, where silence is not.
              await sbInsert("agent_events", [
                {
                  kind: "push-ingest",
                  user_email: email,
                  detail: JSON.stringify({
                    attempted: 0,
                    delivered: 0,
                    skipped: `${event.kind}: ${verdict.reason}`,
                  }).slice(0, 200),
                },
              ]).catch(() => {});
              return;
            }
            const { sendPushToUser } = await import("@/lib/push");
            const shop = data.pushName || `+${from}`;
            const outcome = await sendPushToUser(email, {
              title: `${shop} replied`,
              body: hasImage
                ? "Sent a photo - your agent is reading it now."
                : hasAudio
                  ? "Sent a voice note - your agent is listening."
                  : body.slice(0, 120) || "Tap to see the message.",
              // The shop is identified by its number here (the vendor id lives
              // on the turn, not the raw inbound), and the app resolves it the
              // same way the thread does.
              url: `/?from=${encodeURIComponent(from)}`,
              tag: `shop:${from}`,
            });
            // SPEND THE BUDGET. This site used to skip `markPushSent` on the
            // grounds that the agent turn's upgrade shares the collapse tag -
            // but a push that reaches the phone IS an interruption, and not
            // counting it made the 4-per-hour ceiling advisory.
            await markPushSent(email, `${event.kind}: ${verdict.reason}`);
            // A SEPARATE KIND from `push-sent`, deliberately: that one is the
            // budget ledger, this one is the DELIVERY breadcrumb, so the
            // doctor can answer "did the push actually reach a device, and
            // what did the push service say". Both are written now.
            await sbInsert("agent_events", [
              {
                kind: "push-ingest",
                user_email: email,
                detail: JSON.stringify({
                  attempted: outcome.attempted,
                  delivered: outcome.delivered,
                  pruned: outcome.pruned,
                  reason: outcome.reason ?? null,
                  statuses: outcome.results.filter((r) => !r.ok).map((r) => r.status ?? 0),
                }).slice(0, 200),
              },
            ]).catch(() => {});
          } catch {
            /* a notification never blocks ingest */
          }
        });
      }

      // A real inbound proves the socket is live: persist "open" durably.
      {
        const { markOpen } = await import("@/lib/evolution");
        markOpen(email).catch(() => {});
      }

      // A PDF (or any non-image document) can't go through the vision agent -
      // tell the user honestly instead of dropping it on the floor.
      const docIsImage = Boolean(doc?.mimetype && /^image\//i.test(doc.mimetype));
      // NOT A PUSH. A document we cannot read is real and worth showing, and it
      // is not worth a buzz: the traveller has nothing to decide and the app
      // says so the moment they look. See lib/notify/significance - the whole
      // reason alerts felt like spam was events like this one earning one.
      if (doc && !docIsImage && email) {
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
      // is the common case - read the media, don't skip it. A frame with NO
      // text and NO media (sticker/reaction/system) is a real nothing-to-do
      // drop, but leave a throttled trace so it is never mistaken for silence.
      //
      // A CAPTIONLESS VIDEO IS NOT NOTHING. It used to land here and be
      // discarded: no reply, no placeholder in the transcript, so the traveller
      // saw the shop send something and the agent ignore it. We cannot read the
      // video, but we can say that it arrived and ask for the part we need in
      // words - which is what a person would do.
      if (!syntheticText && hasVideo) syntheticText = "[video]";
      if (!syntheticText && !hasImage && !hasAudio && !docIsImage) {
        void noteInboundDropped(email, from, "empty-media", { via: "webhook" });
        continue;
      }

      // Price-list photo (or image-typed document)?
      //
      // WORKER RUNTIME (Module 3): offload the whole image turn to the vision
      // Flow - the CHILD downloads + OCRs at strict concurrency 2 (RAM-spike
      // isolation on the 1GB VM) and the PARENT continuation composes the
      // reply, or the NEVER-SILENT clarify if the child failed. Nothing heavy
      // runs in this turn.
      if ((hasImage || docIsImage) && email && opts.enqueueVisionFlow) {
        await opts.enqueueVisionFlow({
          waMessageId: msgId,
          fromDigits: from,
          remoteJid: originJid,
          senderEmail: email,
          caption: syntheticText,
          raw: data,
        });
        continue; // the flow's continuation owns this turn from here
      }

      // INLINE PATH: download WITH RETRY so the vision agent can read
      // the prices - a transient media failure must not lose the offer.
      const images: { mime: string; base64: string }[] = [];
      let mediaFetchFailed = false;
      if ((hasImage || docIsImage) && email) {
        const media = await fetchMediaWithRetry(email, data);
        if (media) images.push(media);
        else {
          mediaFetchFailed = true;
          // Honest, and in the app rather than on the lock screen - a photo we
          // could not download is not something the traveller can act on.
          // (lib/notify/significance.)
          await sbInsert("agent_events", [
            {
              kind: "media-fetch-failed",
              vendor_id: "",
              vendor_name: from,
              detail: `Photo from +${from} failed to download after 3 attempts (email ${email}).`,
            },
          ]).catch(() => {});
          // ...and NEVER-SILENT with the SHOP: the old `continue` here left the
          // vendor on read forever. Fall through to processVendorReply with the
          // photo-clarify so the agent warmly asks for the price in text.
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
        // The RESOLVED origin chat - asserted against `from` before attributing.
        // For a privacy @lid chat this is the line the alias resolved to, which
        // is the only identity we are willing to attribute a reply to.
        remoteJid: originJid,
        text: syntheticText,
        images,
        transcript,
        waMessageId: msgId,
        senderEmail: email ?? undefined,
        humanDelay: Boolean(email),
        // A photo we could not download (and no caption to extract from):
        // inject the never-silent clarify so the shop still gets a warm ask
        // for the price in text instead of silence.
        preExtracted:
          mediaFetchFailed && !syntheticText
            ? (await import("@/lib/agent-loop")).photoClarifyExtraction()
            : undefined,
        send: async (to, message) => {
          if (!email) return { ok: false, error: "unknown instance" };
          return sendFromUser(email, to, message);
        },
      });
      } catch (e) {
        // One bad message in the batch must not drop its siblings (DEFECT 5) -
        // the webhook already 200s so Evolution never redelivers. Skip this
        // item, but NEVER silently: this catch swallowed a whole photo turn
        // (media download / vision throw) with zero trace, so the WA doctor
        // reported a healthy thread while the shop got no answer.
        void noteInboundDropped(
          undefined,
          String(data?.key?.remoteJid ?? "").split("@")[0],
          "ingest-error",
          { error: e instanceof Error ? e.message.slice(0, 120) : "unknown" }
        );
      }
    }
  } catch {
    // Never fail the webhook.
  }

  // Opportunistic queue drain: any webhook activity flushes due outbox
  // messages (business-hours / pacing queue) AND due graph wakeups (strategic
  // waits + judge jobs) without a dedicated worker.
  // fast=true: this is the webhook path, not a cron. The presence simulation it
  // skips costs 4-12s PER ROW and buys nothing - the guard, the pacing claims
  // and the recipient mutex are what make a send look human, and they all still
  // run. Paying it here just made the reply we are racing to deliver later.
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    await drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
  } catch {
    /* best-effort */
  }
  try {
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
  } catch {
    /* best-effort */
  }

  // FAST COUNTER-REPLY: the agent's reply we just composed is parked ~10-40s in
  // the future, so the drain above (rows due NOW) cannot send it, and waiting
  // for the next 60s cron would blow the ceiling.
  //
  // This used to kick `/api/wa/tick` alone, and in the field that kick was
  // refused every single time: the tick is ONE GLOBAL runner, and a cold
  // introductions batch keeps a chain alive continuously, so every inbound got
  // "another runner" / "chain already live". The reply lane now has its own
  // per-sender dispatcher that no cold batch can hold - the tick kick stays as
  // the batch's own driver.
  // AWAITED, NOT FIRE-AND-FORGET. This is the same Cloud Run lesson the
  // activity route already learned the hard way: CPU is throttled to ~0 the
  // instant the HTTP response is flushed, so an un-awaited fetch() has no
  // guarantee of even completing its TCP handshake before the instance
  // freezes. The dispatcher lane below is EVERYTHING for reply latency - it is
  // what makes a counter-reply land in seconds instead of whenever the owner
  // next opens the app - and it was being started by exactly that kind of
  // ghost call. `tick`/`reply-tick` themselves already pause 350ms before
  // returning for the same reason; the kick that starts them never did.
  //
  // Awaiting costs the webhook only the time to hand the request off (the
  // dispatchers do their real work in their own invocation and return
  // quickly), and the whole block is bounded so a hung dispatcher can never
  // hold Evolution's webhook open.
  if (opts.origin && opts.token) {
    const origin = opts.origin;
    const token = encodeURIComponent(opts.token);
    const kicks = [
      ...[...touchedSenders].map(
        (sender) =>
          `${origin}/api/wa/reply-tick?token=${token}&sender=${encodeURIComponent(sender)}&hop=0`
      ),
      `${origin}/api/wa/tick?token=${token}&hop=0`,
    ];
    await Promise.all(kicks.map((url) => kickDispatcher(url)));
  }
  // Quiet sessions whose users have not used the app for a while - the link
  // survives, but the device stops looking permanently active on WhatsApp.
  try {
    const { pauseIdleSessions } = await import("@/lib/evolution");
    pauseIdleSessions().catch(() => {});
  } catch {
    /* best-effort */
  }

  return { retryable };
}
