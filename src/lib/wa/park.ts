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

// `robustRequeue` used to live here: the drain claimed a row by DELETING it, so
// a failed re-insert after a failed send meant permanent, silent loss, and the
// re-insert needed a retry-and-log dance of its own. The outbound lifecycle
// (wa/outbox-lifecycle) removed the problem rather than hardening the workaround
// - a claimed row is leased, never deleted, so a re-queue is a patch on a row
// that already exists and there is no insert left to lose.

/**
 * ARM A DRAIN AT `not_before` (dependency-inverted, exactly like the vision
 * Flow hook - this file must never import BullMQ into the Next bundle).
 *
 * A reply parked 6-15s out was still gated by whatever ran next: the worker's
 * 20s heartbeat, or nothing at all until the following one. So the delay the
 * composer chose was a FLOOR, and the real latency was that floor plus up to a
 * full heartbeat - which is how a "snappy" reply still read as a minute away.
 * The worker runtime sets this to a delayed drain job scheduled at exactly the
 * moment the row comes due.
 *
 * Unset (the Next runtime) it is a no-op: that path already kicks the
 * self-chaining /api/wa/tick, which waits the row out in-process.
 */
let armDrainAt: ((atMs: number) => void) | null = null;

export function setDrainArmer(fn: ((atMs: number) => void) | null): void {
  armDrainAt = fn;
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
  // A row EXISTS for this shop either way (fresh insert, or the concurrent
  // compose we lost to), so arming the drain is correct in both branches - and
  // the arm must never be able to break the park.
  try {
    armDrainAt?.(row.notBeforeMs);
  } catch {
    /* a missed arm only costs the next heartbeat, never the message */
  }
}
