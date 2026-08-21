import "server-only";
import type { CallIntentFact } from "../types";

// WHERE "THE SHOP WANTS TO TALK" LIVES (K7).
//
// On the thread's own `fields` blob, beside every other durable thread fact,
// for the same reason the substitution choice lives there: loadState already
// reads it on every turn and /api/replies already joins it, so there is no
// fourth store to keep in sync and no migration to run.
//
// readCallIntent (semantic/classifiers.ts) was exported, zod-validated, and
// had ZERO callers - "can you call me?" scrolled past every surface inside a
// foreign-language transcript. This file is the missing half: the model's
// verdict, made durable, so the card can put a chip on it.

interface ThreadRow {
  thread_key: string;
  fields: (Record<string, unknown> & { wantsCall?: CallIntentFact | null }) | null;
}

/**
 * Persist the model's call-intent verdict on the newest thread for this shop.
 * NEWEST READING WINS - unlike the substitution choice (ask once), a call
 * request is a STATE: a shop that asked yesterday and negotiated happily by
 * text today should not wear the chip forever, so a later read may overwrite
 * an earlier one.
 */
export async function persistCallIntent(args: {
  email: string;
  vendorId: string;
  intent: CallIntentFact;
}): Promise<boolean> {
  try {
    // sbSelectStrict, not sbSelect: a schema error must read as "unavailable",
    // never as "no such thread" (the exact bug that kept persistAlternativeOffer
    // dead through a full audit round).
    const { sbSelectStrict, sbUpdate } = await import("../runtime-config");
    const read = await sbSelectStrict<ThreadRow>(
      "negotiation_threads",
      `select=thread_key,fields&user_email=eq.${encodeURIComponent(
        args.email
      )}&vendor_id=eq.${encodeURIComponent(args.vendorId)}&order=updated_at.desc&limit=1`
    );
    if ("error" in read) return false;
    const row = read.rows[0];
    if (!row) return false;
    await sbUpdate(
      "negotiation_threads",
      `thread_key=eq.${encodeURIComponent(row.thread_key)}`,
      { fields: { ...(row.fields ?? {}), wantsCall: args.intent } }
    );
    return true;
  } catch {
    return false;
  }
}
