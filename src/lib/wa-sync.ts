// Webhook-independent inbound sync (reliability core).
//
// The webhook is the fast path, but it is LOSSY: if the Evolution host was
// crashing, restarting or asleep when the shop replied, the event never reaches
// the app and the reply "exists in WhatsApp but not in the app". This module is
// the truth-reconciler: while a user is actively waiting on shops, we PULL the
// recent messages of their open threads straight from Evolution and process any
// inbound the webhook missed. Called opportunistically from /api/replies (the
// poll the app already runs every 15s), throttled per user.

import "server-only";
import { sbSelect, sbInsert } from "./runtime-config";
import { fetchMessagesRaw, fetchMediaBase64, sendFromUser, resolveChatJid } from "./evolution";
import { processVendorReply } from "./agent-loop";
import { noteInboundDropped } from "./wa/webhook-trace";
import { digitsOnly } from "./phone";

const SYNC_MIN_GAP_MS = 12_000; // at most one real sync per user per 12s (snappy recovery)
const THREAD_WINDOW_H = 36; // only threads we messaged in the last 36h
const MAX_THREADS = 5;
// Hard latency budget: the sync runs INSIDE the user's poll request, so it
// must stay snappy - anything not reconciled this round is caught next poll.
const RUN_BUDGET_MS = 8_000;

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_sync__: Map<string, number> | undefined;
}
function lastSyncStore() {
  if (!globalThis.__wd_wa_sync__) globalThis.__wd_wa_sync__ = new Map();
  return globalThis.__wd_wa_sync__;
}

/**
 * Distinct users who sent an outbound WhatsApp message recently - the candidate
 * pool for the scheduler's app-closed inbound-recovery sweep. Cheap single scan.
 */
export async function recentActiveSenders(hours = 36, scan = 100): Promise<string[]> {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await sbSelect<{ raw: { sender?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&received_at=gte.${encodeURIComponent(
      since
    )}&order=received_at.desc&limit=${scan}`
  ).catch(() => []);
  const emails = new Set<string>();
  for (const r of rows) {
    const s = r.raw?.sender;
    if (typeof s === "string" && s.includes("@")) emails.add(s.toLowerCase());
  }
  return [...emails];
}

/**
 * Reconcile recent inbound replies for one user. Returns how many missed
 * messages were recovered (0 on the throttled fast path).
 */
export async function syncInboundReplies(email: string): Promise<number> {
  const store = lastSyncStore();
  const last = store.get(email) ?? 0;
  if (Date.now() - last < SYNC_MIN_GAP_MS) return 0;
  store.set(email, Date.now());

  // The numbers this user recently messaged (their open shop threads).
  const since = new Date(Date.now() - THREAD_WINDOW_H * 3600_000).toISOString();
  const outbound = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&received_at=gte.${encodeURIComponent(since)}&order=received_at.desc&limit=60`
  ).catch(() => []);
  const numbers = [...new Set(outbound.map((o) => digitsOnly(o.to_number)))]
    .filter((n) => n.length >= 7)
    .slice(0, MAX_THREADS);
  if (numbers.length === 0) return 0;

  let recovered = 0;
  const deadline = Date.now() + RUN_BUDGET_MS;
  for (const digits of numbers) {
    if (Date.now() > deadline) break; // stay snappy - next poll continues
    try {
      // SAME ingestion gate as the webhook: a finished drill (owner testing
      // against a friend's REAL number) must stop being pulled in here too -
      // this path used to keep ingesting the friend's private chats for the
      // whole 36h window after the webhook had already stopped.
      const { isVendorThread } = await import("./drill");
      if (!(await isVendorThread(digits, email))) {
        void noteInboundDropped(email, digits, "vendor-gate", { via: "sync" });
        continue;
      }
      // Resolve the EXACT chat JID (handles @lid privacy JIDs and format
      // variants). A hardcoded "<digits>@s.whatsapp.net" misses those, which is
      // what made the server-side filter fall through to an UNSCOPED whole-inbox
      // read - the root of personal chats being stapled onto shop threads.
      const jid = (await resolveChatJid(email, digits)) ?? `${digits}@s.whatsapp.net`;
      const msgs = await fetchMessagesRaw(email, jid, 10);
      const inbound = msgs.filter(
        (m) =>
          !m.fromMe &&
          (m.text.trim() || m.hasImage) &&
          // PRIVACY (per-message origin assertion): the message MUST belong to
          // THIS exact chat. Even if any upstream read ever returned wider data,
          // a personal chat's message is dropped here - never stapled onto the
          // shop thread. @lid JIDs match only by exact equality (their numeric
          // part is not the phone number).
          (m.remoteJid === jid || digitsOnly(m.remoteJid) === digits) &&
          // ignore ancient history - only the active window matters
          m.ts * 1000 > Date.now() - THREAD_WINDOW_H * 3600_000 &&
          // RACE GUARD: give the webhook a 10s head start on brand-new
          // messages. If both paths ingest the same message simultaneously,
          // the dedupe makes NEITHER process it - so the sync only touches
          // messages the webhook has clearly missed. 10s keeps recovery snappy
          // while still letting a working webhook win the race.
          m.ts * 1000 < Date.now() - 10_000
      );
      if (inbound.length === 0) continue;

      // Which of these already made it in via the webhook?
      const ids = inbound.map((m) => m.id);
      const seen = await sbSelect<{ wa_message_id: string }>(
        "whatsapp_messages",
        `select=wa_message_id&direction=eq.inbound&wa_message_id=in.(${ids
          .map((i) => `"${i}"`)
          .join(",")})&limit=${ids.length}`
      ).catch(() => []);
      const seenIds = new Set(seen.map((s) => s.wa_message_id));

      // SELF-ECHO GUARD (mirrors the webhook's): if Evolution's stored record
      // lost the fromMe flag, a message the USER typed would come back here
      // labelled inbound - and the risk screen would then "flag the shop" for
      // the user's own words. Anything matching OUR recent outbound (agent or
      // human-manual) in this thread is skipped.
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const ours = await sbSelect<{ body: string; wa_message_id: string | null }>(
        "whatsapp_messages",
        `select=body,wa_message_id&direction=eq.outbound&to_number=eq.${encodeURIComponent(
          digits
        )}&raw->>sender=eq.${encodeURIComponent(email)}&received_at=gte.${encodeURIComponent(
          new Date(Date.now() - 24 * 3600_000).toISOString()
        )}&order=received_at.desc&limit=30`
      ).catch(() => []);
      const ourBodies = new Set(ours.map((o) => norm(o.body || "")).filter(Boolean));
      const ourIds = new Set(ours.map((o) => o.wa_message_id).filter(Boolean));

      for (const m of inbound) {
        if (seenIds.has(m.id)) continue;
        if (ourIds.has(m.id)) continue; // our own send, mislabelled inbound
        if (m.text.trim() && ourBodies.has(norm(m.text))) continue; // self-echo
        recovered += 1;
        // Mirror the webhook's insert so the thread history stays coherent.
        await sbInsert("whatsapp_messages", [
          {
            wa_message_id: m.id,
            from_number: digits,
            to_number: "",
            body: m.text || (m.hasImage ? "[photo]" : ""),
            type: m.hasImage ? "image" : "text",
            direction: "inbound",
            // receiver = the user whose WhatsApp this sync ran for - without
            // it a recovered row would be invisible to every scoped read.
            raw: { channel: "evolution", recovered: true, receiver: email },
          },
        ]).catch(() => {});

        const images: { mime: string; base64: string }[] = [];
        if (m.hasImage) {
          const media = await fetchMediaBase64(email, m.record);
          if (media) images.push(media);
        }
        await processVendorReply({
          fromDigits: digits,
          remoteJid: m.remoteJid, // verified above to belong to this chat
          text: m.text,
          images,
          waMessageId: m.id,
          senderEmail: email,
          humanDelay: true,
          send: (to, message) => sendFromUser(email, to, message),
        }).catch(() => {});
      }
    } catch (e) {
      /* one broken thread must not kill the sync - but trace it (the pull
         failing silently is exactly what could hide a real shop reply). */
      void noteInboundDropped(email, digits, "sync-error", {
        msg: e instanceof Error ? e.message.slice(0, 120) : "unknown",
      });
    }
  }
  return recovered;
}
