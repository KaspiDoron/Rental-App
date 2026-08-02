import "server-only";
import {
  mergeAccessoryVerdicts,
  type AccessoryStatus,
  type AccessoryVerdictInput,
} from "./accessories";

// READING THE SHOP'S ANSWER ABOUT EACH EXTRA, AND REMEMBERING IT.
//
// This runs AFTER the turn has been composed and sent, deliberately. It is
// bookkeeping, not a rail and not part of the reply, so it must never sit on
// the critical path between a shop's message and our answer - the whole
// reply-latency effort exists to keep that path short.
//
// It is also bounded by the request itself: no requested extras, no call. Most
// hunts ask for a helmet and nothing else, so in practice this costs one small
// model call on the turns where it can actually learn something.

/** Read the shop's message for verdicts and fold them into the thread. */
export async function recordAccessoryVerdicts(args: {
  email: string;
  vendorId: string;
  /** The traveller's own wording for each extra they asked for. */
  requested: string[];
  /** The shop's message, verbatim. */
  inboundText: string;
  /** What the thread already knew. */
  now?: number;
}): Promise<{ verdicts: AccessoryVerdictInput[] | null; degraded: boolean }> {
  const requested = args.requested.map((r) => r.trim()).filter(Boolean).slice(0, 12);
  if (!requested.length || !args.inboundText.trim() || !args.email || !args.vendorId) {
    return { verdicts: null, degraded: false };
  }

  const { readAccessoryVerdicts } = await import("../semantic/classifiers");
  const outcome = await readAccessoryVerdicts(args.inboundText, requested).catch(() => null);

  // NO PROVIDER MEANS NO VERDICT, AND SAYING SO IS THE POINT. The alternative -
  // falling back to a keyword scan - is how a feature quietly starts producing
  // confident wrong answers the moment the model chain is down. An unknown
  // accessory renders as unknown, which is true.
  if (!outcome || !outcome.value) {
    return { verdicts: null, degraded: Boolean(outcome?.degraded) };
  }

  return { verdicts: outcome.value.items, degraded: false };
}

/**
 * Merge the verdicts into `negotiation_threads.fields`, touching that one key.
 *
 * Read-modify-write on a JSONB blob is a lost-update risk, so this re-reads
 * immediately before writing and writes ONLY `accessories` back over whatever
 * it just read - the engine's own saveState has already completed by the time
 * this runs (the turn is awaited), and any field it wrote is carried through
 * verbatim rather than reconstructed from a stale copy.
 */
export async function persistAccessoryStatus(args: {
  email: string;
  vendorId: string;
  requested: string[];
  verdicts: AccessoryVerdictInput[];
  now?: number;
}): Promise<AccessoryStatus[] | null> {
  try {
    const { sbSelectStrict, sbUpdate } = await import("../runtime-config");
    const enc = encodeURIComponent(args.email);
    const vid = encodeURIComponent(args.vendorId);
    // THE COLUMN THIS ASKED FOR HAS NEVER EXISTED.
    //
    // `negotiation_threads` is keyed by `thread_key` (schema.sql: "thread_key
    // text primary key") - there is no `id`. PostgREST answers `select=id` on
    // such a table with 400/42703, sbSelect collapses every failure to [], and
    // so this function returned null on EVERY call, for EVERY user, since it
    // was written. `vendor.offer.accessories` was undefined for every vendor in
    // every session, which is why the verdict chips have never once rendered.
    //
    // sbSelectStrict rather than sbSelect for the read: swallowing the schema
    // error into "no such thread" is exactly what hid this for a whole audit
    // round. "missing" (no table yet, fresh install) is a real empty; only a
    // genuine read failure is now indistinguishable from it, and neither is
    // silently reported as success.
    const read = await sbSelectStrict<{
      thread_key: string;
      fields: (Record<string, unknown> & { accessories?: AccessoryStatus[] }) | null;
    }>(
      "negotiation_threads",
      `select=thread_key,fields&user_email=eq.${enc}&vendor_id=eq.${vid}&order=updated_at.desc&limit=1`
    );
    if ("error" in read) {
      if (read.error === "unavailable") {
        console.error("[accessories] negotiation_threads unreadable - verdicts not persisted");
      }
      return null;
    }
    const row = read.rows[0];
    if (!row) return null;
    // MERGE AGAINST WHAT WE JUST READ, not against a copy taken before the
    // turn. A shop that confirmed helmets three messages ago must not be
    // un-confirmed by a message that happened not to mention them.
    const status = mergeAccessoryVerdicts(row.fields?.accessories, args.verdicts, {
      requested: args.requested,
      at: args.now ?? Date.now(),
    });
    await sbUpdate(
      "negotiation_threads",
      `thread_key=eq.${encodeURIComponent(row.thread_key)}`,
      { fields: { ...(row.fields ?? {}), accessories: status } }
    );
    return status;
  } catch {
    // Bookkeeping never breaks a turn. The next inbound message re-reads the
    // whole conversation anyway, so a missed write self-heals.
    return null;
  }
}
