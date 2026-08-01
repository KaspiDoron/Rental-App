import "server-only";

// WHICH MOVE ARE WE SCORING?
//
// The outbound row already carries it. Every send writes `raw` as a spread of
// the outbox row's meta, and the SPTE turn stamps `tacticId: outcome.move` into
// that meta - so the newest outbound message in a thread names the move we
// played last. Nothing ever read it back, which is the whole reason the
// learning loop had no live input.

import { sbSelect } from "../runtime-config";
import { numberFilter } from "../wa/phone-key";

/**
 * The tactic id of the newest message WE sent this shop, or null.
 *
 * Scoped by sender the same way every other outbound read is - a shared number
 * must never let one traveller's turn credit another's tactic.
 */
export async function lastTacticId(
  senderEmail: string,
  toDigits: string
): Promise<string | null> {
  const email = String(senderEmail ?? "").trim().toLowerCase();
  const digits = String(toDigits ?? "").trim();
  if (!email || !digits) return null;

  const rows = await sbSelect<{ raw: { tacticId?: string; move?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&order=received_at.desc&limit=1${numberFilter("to_number", digits)}`
  ).catch(() => []);

  const raw = rows[0]?.raw;
  // `move` is the same value under its engine-side name; either spelling is the
  // move that was played.
  const id = String(raw?.tacticId ?? raw?.move ?? "").trim();
  return id || null;
}
