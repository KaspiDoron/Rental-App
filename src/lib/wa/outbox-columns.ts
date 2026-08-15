import "server-only";
import { tableReady } from "../schema-probe";
import { outboxKey } from "./phone-key";

/**
 * ONE SEATBELT FOR `wa_outbox.to_key`, WORN BY EVERY INSERT.
 *
 * `to_key` (the canonical per-shop key behind the one-pending-row unique index)
 * is NEWER than some databases this code can reach: it arrives via an
 * `alter table ... add column if not exists` at the bottom of schema.sql, so a
 * deployment that has not re-run schema.sql does not have it.
 *
 * `parkOutboxOnce` knew this and probed. It was the only one. The guard's own
 * park, both outreach routes and the graph engine all named `to_key`
 * unconditionally, so against an un-migrated database those inserts 400 -
 * PostgREST rejects the whole record for one unknown column. The consequences
 * are not symmetric:
 *
 *   - the drain survives, because `needsRepark` re-parks a verdict that carries
 *     no `queuedUntil`;
 *   - every NON-drain caller of the guard (the interactive outreach send, the
 *     graph engine's park, a deal-close) receives `{allow:false}` with no row
 *     behind it and no `queuedUntil` to show, so the traveller is told the
 *     message is queued while nothing is queued anywhere.
 *
 * A missing column must cost the tolerant duplicate-suppression the index
 * provides, never the message. The probe caches positives forever and negatives
 * for a minute, so the owner running schema.sql takes effect without a redeploy.
 */
export async function outboxToKeyPatch(toNumber: string): Promise<{ to_key?: string }> {
  const ready = (await tableReady("wa_outbox", "to_key")) === "ready";
  return ready ? { to_key: outboxKey(toNumber) } : {};
}
