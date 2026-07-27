// PRIVACY-JID ALIASES: giving an @lid chat a name we can route on.
//
// WhatsApp is migrating chats to privacy identities. When it does, an inbound
// message arrives with `key.remoteJid = "<opaque>@lid"` and NO phone number in
// the obvious place. Every layer of this app routes on a phone key, so an @lid
// reply had exactly two possible fates, and both were wrong:
//
//   - drop it (what we did): the shop answered and the traveller never saw it,
//     the agent stayed silent, and the thread looked like a ghosting shop;
//   - route on the lid's own digits: they are NOT a phone number, so the reply
//     would be filed under a number nobody owns - and in the worst case under
//     someone else's real number.
//
// The missing capability was an ALIAS: an @lid is a second name for a line we
// may already know. This module resolves the alias FROM EVIDENCE ONLY, in
// descending order of certainty, and fails CLOSED when there is none. A
// resolution is never a guess, so the privacy rule ("only chats this user's
// agent opened") survives the migration untouched.
//
// Nothing here needs a migration: a learned alias is written into the `raw`
// JSONB we already store on the inbound row, so it survives a process restart.

import { boundedSet } from "../bounded-map";
import { isPhoneJid, lidKey, waDigits } from "./phone-key";

/** How the phone behind an @lid was established - carried into traces. */
export type AliasVia = "jid" | "payload" | "memory" | "thread";

export interface ResolvedIdentity {
  /** Canonical phone key for the chat. */
  phone: string;
  via: AliasVia;
  /** The privacy identifier, when this chat is addressed by one. */
  lid: string;
}

// Payload fields Evolution/Baileys are known to carry the real phone JID in for
// a lid-addressed chat. Each candidate is VALIDATED as a phone JID before it is
// believed, so an unknown build adding a new field can never inject junk.
const PAYLOAD_PATHS = [
  ["key", "remoteJidAlt"],
  ["key", "senderPn"],
  ["key", "participantPn"],
  ["key", "previousRemoteJid"],
  ["senderPn"],
  ["remoteJidAlt"],
] as const;

function at(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * The phone JID the provider itself attached to this frame, when it did.
 * PURE - this is the whole reason an @lid chat can be resolved without a
 * network call, and it is the only branch that can learn a NEW alias.
 */
export function phoneFromPayload(data: unknown): string {
  for (const path of PAYLOAD_PATHS) {
    const v = at(data, path);
    if (typeof v !== "string" || !v) continue;
    if (!isPhoneJid(v)) continue;
    const digits = waDigits(v);
    if (digits.length >= 8) return digits;
  }
  return "";
}

// ---- learned aliases (process memory, bounded, best-effort) ----------------

const ALIAS_CAP = 5000;

function aliasStore(): Map<string, string> {
  const g = globalThis as unknown as { __wd_wa_lid_alias__?: Map<string, string> };
  if (!g.__wd_wa_lid_alias__) g.__wd_wa_lid_alias__ = new Map();
  return g.__wd_wa_lid_alias__;
}

/** Scoped per receiving user: an alias learned in one inbox is not evidence in
 * another (two users can hold different chats behind the same opaque id). */
function aliasKey(email: string, lid: string): string {
  return `${email}|${lid}`;
}

export function rememberAlias(email: string, lid: string, phone: string): void {
  if (!email || !lid || !phone) return;
  boundedSet(aliasStore(), aliasKey(email, lid), phone, ALIAS_CAP);
}

export function aliasFromMemory(email: string, lid: string): string {
  if (!email || !lid) return "";
  return aliasStore().get(aliasKey(email, lid)) ?? "";
}

/** Test seam: drop learned aliases (each test starts from no knowledge). */
export function resetAliases(): void {
  aliasStore().clear();
}

/**
 * Resolve the chat this frame belongs to. Phone chats resolve trivially; an
 * @lid chat resolves only through evidence:
 *   1. the provider's own phone field on this frame  (learns the alias)
 *   2. an alias this process already learned
 *   3. an alias persisted on an earlier inbound row for THIS receiver
 * and otherwise not at all - the caller drops the frame with a trace rather
 * than attributing it to a number we cannot prove.
 */
export async function resolveChatIdentity(
  email: string,
  remoteJid: string,
  data: unknown
): Promise<ResolvedIdentity | null> {
  if (isPhoneJid(remoteJid)) {
    const phone = waDigits(remoteJid);
    return phone ? { phone, via: "jid", lid: "" } : null;
  }

  const lid = lidKey(remoteJid);
  if (!lid) return null;

  const fromPayload = phoneFromPayload(data);
  if (fromPayload) {
    rememberAlias(email, lid, fromPayload);
    return { phone: fromPayload, via: "payload", lid };
  }

  const remembered = aliasFromMemory(email, lid);
  if (remembered) return { phone: remembered, via: "memory", lid };

  const stored = await aliasFromThreads(email, lid);
  if (stored) {
    rememberAlias(email, lid, stored);
    return { phone: stored, via: "thread", lid };
  }

  return null;
}

/**
 * An alias we wrote onto an earlier inbound row (`raw.lid`) for this receiver.
 * Scoped to the receiver, so one user's chats can never name another's.
 * Returns "" on any failure - a missing alias is a normal outcome.
 */
async function aliasFromThreads(email: string, lid: string): Promise<string> {
  if (!email || !lid) return "";
  const { sbSelect } = await import("../runtime-config");
  const rows = await sbSelect<{ from_number: string }>(
    "whatsapp_messages",
    `select=from_number&direction=eq.inbound&raw->>lid=eq.${encodeURIComponent(
      lid
    )}&raw->>receiver=eq.${encodeURIComponent(email)}&order=received_at.desc&limit=1`
  ).catch(() => [] as { from_number: string }[]);
  return waDigits(rows[0]?.from_number ?? "");
}
