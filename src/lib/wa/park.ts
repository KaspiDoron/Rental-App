import { sbInsert, sbDelete, sbSelect } from "../runtime-config";

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
 *
 * ROBUSTNESS (overnight audit DEFECT 1): the insert result used to be discarded,
 * so a transient write blip on the insert half (after the delete succeeded) left
 * the shop with NOTHING queued and no trace, and a unique-index conflict from a
 * concurrent compose silently dropped a reply. Now the insert result is checked:
 * a conflict means a pending reply already exists (fine - a reply IS queued); a
 * genuine failure retries once and, if still failing, logs a visible
 * `wa-park-failed` event so a lost park is never silent (a future inbound/tick
 * recomposes - the thread is not stuck).
 */
const PENDING_AUTO = "meta->>kind=not.in.(rfq,custom,human-manual)";

/**
 * Re-insert a wa_outbox row that the drain ALREADY CLAIMED (delete-returning) and
 * then failed to send. Because the source row is gone, a discarded failed insert
 * = permanent loss with no trace (audit DEFECT 2). This retries once for a
 * transient write blip and, if still failing, logs a visible `wa-requeue-failed`
 * event so the loss is never silent. Used by the drain's transient/recipient
 * re-queue paths.
 */
export async function robustRequeue(
  record: Record<string, unknown>,
  tag: string
): Promise<void> {
  let ok = await sbInsert("wa_outbox", [record]).catch(() => false);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 250));
    ok = await sbInsert("wa_outbox", [record]).catch(() => false);
  }
  if (!ok) {
    await sbInsert("agent_events", [
      {
        kind: "wa-requeue-failed",
        vendor_name: String(record.to_number ?? ""),
        detail: `Re-queue of a claimed send failed twice (${tag}) - the row could not be persisted.`,
      },
    ]).catch(() => {});
  }
}

export async function parkOutboxOnce(row: {
  senderKey: string;
  toNumber: string;
  body: string;
  notBeforeMs: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const scope = `sender_key=eq.${encodeURIComponent(row.senderKey)}&to_number=eq.${encodeURIComponent(
    row.toNumber
  )}&${PENDING_AUTO}`;
  await sbDelete("wa_outbox", scope).catch(() => {});
  const record = {
    sender_key: row.senderKey,
    to_number: row.toNumber,
    body: row.body,
    not_before: new Date(row.notBeforeMs).toISOString(),
    meta: row.meta ?? {},
  };
  let ok = await sbInsert("wa_outbox", [record]);
  if (!ok) {
    // The insert failed. Either a concurrent compose already queued a pending
    // row (unique-index conflict - a reply IS queued, nothing to do) OR a
    // transient write blip lost it (the delete above may already have removed the
    // prior pending reply, so we must not leave the shop silent). Distinguish by
    // probing for an existing pending auto row.
    const existing = await sbSelect<{ id: number }>("wa_outbox", `select=id&${scope}&limit=1`).catch(
      () => [] as { id: number }[]
    );
    if (existing.length === 0) {
      ok = await sbInsert("wa_outbox", [record]); // retry the blip once
      if (!ok) {
        await sbInsert("agent_events", [
          {
            kind: "wa-park-failed",
            vendor_id: String((row.meta as { vendorId?: string } | undefined)?.vendorId ?? ""),
            vendor_name: String(
              (row.meta as { vendorName?: string } | undefined)?.vendorName ?? row.toNumber
            ),
            detail: `Could not queue a composed reply to +${row.toNumber} (sender ${row.senderKey}) - write failed twice. A later inbound/tick recomposes.`,
          },
        ]).catch(() => {});
      }
    }
  }
}
