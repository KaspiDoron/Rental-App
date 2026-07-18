import { sbInsert, sbDelete } from "../runtime-config";

/**
 * Park an auto-composed WhatsApp message in wa_outbox with STRICT
 * one-row-per-shop dedup.
 *
 * The bug this fixes: the human-delay parks (graph engine + agent loop) inserted
 * a fresh wa_outbox row on every composed turn with no check for an existing
 * pending row to the same shop, and the wakeup-retry re-runs a turn that already
 * queued - so a single shop that was awaiting a reply piled up as 4 duplicate
 * queued messages, which then burned the anti-ban budget and pushed every other
 * shop's send an hour out.
 *
 * Invariant: at most ONE pending outbox row per (sender_key, to_number). A newer
 * composition REPLACES any older pending one (the latest message is the one to
 * send). This is safe because a shop only reaches these compose paths once it is
 * in an active thread, and a reply implies its RFQ already sent (so no unsent
 * RFQ is ever collapsed). Per-thread composition is serialized by the wakeup
 * claim, so the delete-then-insert window is negligible; a concurrent drain that
 * claims the old row first just means the newer row supersedes a sent one - no
 * duplicate either way. It also self-heals any pre-existing duplicates: the next
 * compose to that shop collapses them to one.
 */
export async function parkOutboxOnce(row: {
  senderKey: string;
  toNumber: string;
  body: string;
  notBeforeMs: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await sbDelete(
    "wa_outbox",
    `sender_key=eq.${encodeURIComponent(row.senderKey)}&to_number=eq.${encodeURIComponent(
      row.toNumber
    )}`
  ).catch(() => {});
  await sbInsert("wa_outbox", [
    {
      sender_key: row.senderKey,
      to_number: row.toNumber,
      body: row.body,
      not_before: new Date(row.notBeforeMs).toISOString(),
      meta: row.meta ?? {},
    },
  ]);
}
