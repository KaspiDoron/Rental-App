// Store-level idempotency for inbound WhatsApp messages.
//
// Two DIFFERENT things need exactly-once semantics, and conflating them caused
// two separate bugs:
//
//   1. STORING the message row. Evolution redelivers webhooks and the recovery
//      sync pulls the same window, so an unconditional insert produced the
//      duplicate "[photo]" rows visible in the transcript. -> claimInboundStore
//
//   2. REPLYING to the message. Exactly one agent turn per message.
//      -> the existing wa_processed claim in agent-loop.
//
// They must stay separate: the reply claim is taken only once a thread actually
// resolves, so a message dropped as "no-rfq-thread" can still be replayed after
// the thread is repaired. If one claim served both, every dropped message would
// be permanently unrecoverable.
//
// Storage: a `wa_inbound_seen` row keyed by the provider message id. The table
// is created by schema.sql; when it is missing (un-migrated deployment) we FAIL
// OPEN - a duplicate row is far better than silently losing a shop's reply.

import "server-only";
import { sbInsertReturning, sbSelect } from "../runtime-config";

/**
 * RECEIVER-SCOPED CLAIM KEY (owner report 6, H4). Both claim tables are keyed
 * by the bare provider message id - which WhatsApp does NOT promise is unique
 * across RECEIVERS. A shop broadcasting one promo to two travellers delivers
 * the same id to both; whoever's webhook lands first claims it globally and
 * the second traveller's copy is silently dropped as a "duplicate" of a
 * message they never saw. Scoping the key by the receiving account makes the
 * claim mean what it always intended: "THIS user's copy is handled."
 *
 * Legacy rows carry the bare id; every reader below honors BOTH spellings so
 * a deploy never re-answers what an older instance already claimed.
 */
export function claimKey(receiverEmail: string | null | undefined, waMessageId: string): string {
  const id = (waMessageId || "").trim();
  const who = (receiverEmail || "").trim().toLowerCase();
  return who && id ? `${who}:${id}` : id;
}

/**
 * Hand a reply claim BACK.
 *
 * The claim is a LEASE on "someone is answering this message", not a tombstone
 * meaning "this message is finished with". It was being used as the latter: the
 * row was inserted before the thread even resolved and was never removed, so a
 * turn that threw - an LLM outage, a Supabase blip, any exception between the
 * claim and the send - left the message permanently un-replyable AND
 * un-replayable. The recovery sweep could not help either, because it skips
 * anything already STORED and never asks whether a reply happened.
 *
 * That is one shop out of seven going quiet with nothing in any log.
 */
export async function releaseReplyClaim(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<void> {
  const id = (waMessageId || "").trim();
  if (!id) return;
  try {
    const { sbDelete } = await import("../runtime-config");
    // Both spellings (H4): the claim may have been taken scoped or bare.
    const scoped = claimKey(receiverEmail, id);
    const keys = scoped === id ? [id] : [id, scoped];
    await sbDelete(
      "wa_processed",
      `wa_message_id=in.(${keys.map((k) => `"${k}"`).join(",")})`
    );
  } catch {
    /* best effort - the next redelivery or sweep retries */
  }
}

/**
 * Hand a STORE claim back - taken when the winner's insert then FAILED. The
 * claim without a row behind it turned every redelivery into a silent no-op:
 * the message existed nowhere, and the dedup layer guaranteed it never would.
 */
export async function releaseInboundStore(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<void> {
  const id = (waMessageId || "").trim();
  if (!id) return;
  try {
    const { sbDelete } = await import("../runtime-config");
    const scoped = claimKey(receiverEmail, id);
    const keys = scoped === id ? [id] : [id, scoped];
    await sbDelete(
      "wa_inbound_seen",
      `wa_message_id=in.(${keys.map((k) => `"${k}"`).join(",")})`
    );
  } catch {
    /* best effort - the sweep can still re-pull the window */
  }
}

/**
 * True when THIS caller owns the message and should store it. False when
 * another delivery already stored it (skip). Fails open (true) if the claim
 * store is unavailable.
 *
 * (This doc block used to sit sixty lines up, immediately above
 * `releaseReplyClaim`, so every IDE hover on that function showed the contract
 * of a different one - "fails open (true)" for a function that returns void.)
 */
export async function claimInboundStore(
  waMessageId: string,
  receiverEmail?: string | null
): Promise<boolean> {
  const id = (waMessageId || "").trim();
  if (!id) return true; // no id to dedupe on - store it
  const key = claimKey(receiverEmail, id);
  try {
    // Legacy first (H4): a bare-id row from before scoping means THIS message
    // was already stored by an older instance - honor it before writing a
    // scoped claim beside it would double-store the row.
    if (key !== id) {
      const legacy = await sbSelect<{ wa_message_id: string }>(
        "wa_inbound_seen",
        `select=wa_message_id&wa_message_id=eq.${encodeURIComponent(id)}&limit=1`
      );
      if (legacy.length > 0) return false;
    }
    const claimed = await sbInsertReturning<{ wa_message_id: string }>("wa_inbound_seen", [
      { wa_message_id: key },
    ]);
    if (claimed.length > 0) return true; // we won the race
    // Insert returned nothing: either a duplicate-key conflict (someone else
    // owns it) or the table is missing. Distinguish, so a missing table never
    // silences inbound.
    const existing = await sbSelect<{ wa_message_id: string }>(
      "wa_inbound_seen",
      `select=wa_message_id&wa_message_id=eq.${encodeURIComponent(key)}&limit=1`
    );
    return existing.length === 0; // present => already stored => skip
  } catch {
    return true; // store unreachable - never drop a real shop reply
  }
}
