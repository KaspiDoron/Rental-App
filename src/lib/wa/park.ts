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
 * Invariant: at most ONE pending AUTO-COMPOSE row per (sender_key, to_number). A
 * newer auto composition REPLACES any older pending auto row (the latest message
 * is the one to send). The delete is KIND-SCOPED - it never touches a pending
 * `rfq` (a fresh outreach a shop has not received yet), a user-typed `custom`
 * message, or a `human-manual` row. Without that scoping, a shop from an EARLIER
 * search replying late (its 14-day thread is still ingestible) while a NEW RFQ
 * to the same number is queued would silently delete that unsent RFQ. Per-thread
 * composition is serialized by the wakeup claim, so the delete-then-insert
 * window is negligible; it also self-heals pre-existing auto duplicates.
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
    )}&meta->>kind=not.in.(rfq,custom,human-manual)`
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
