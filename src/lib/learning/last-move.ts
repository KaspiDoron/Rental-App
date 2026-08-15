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

/** What we played last turn, and which phrasing arm it was in. */
export interface LastMove {
  tacticId: string;
  /** The A/B arm (negotiation/ask-variant), when the last move was a bargain. */
  askVariant?: string;
  /** The counter we named, or undefined when we named none - the arm's own
   *  discriminator, kept so a contaminated sample can be excluded. */
  counterPricePerDay?: number;
}

/**
 * The move we played last, WITH its phrasing arm.
 *
 * The arm is read off the same outbound row as the move, which is the join the
 * A/B needs: the shop's next reply is the outcome of THAT message, so the arm
 * that message was written in is the arm the concession belongs to.
 *
 * Scoped by sender the same way every other outbound read is - a shared number
 * must never let one traveller's turn credit another's tactic.
 */
export async function lastMove(senderEmail: string, toDigits: string): Promise<LastMove | null> {
  const email = String(senderEmail ?? "").trim().toLowerCase();
  const digits = String(toDigits ?? "").trim();
  if (!email || !digits) return null;

  const rows = await sbSelect<{
    raw: {
      tacticId?: string;
      move?: string;
      askVariant?: string;
      counterPricePerDay?: number | null;
    } | null;
  }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&order=received_at.desc&limit=1${numberFilter("to_number", digits)}`
  ).catch(() => []);

  const raw = rows[0]?.raw;
  // `move` is the same value under its engine-side name; either spelling is the
  // move that was played.
  const id = String(raw?.tacticId ?? raw?.move ?? "").trim();
  if (!id) return null;
  const counter = Number(raw?.counterPricePerDay);
  return {
    tacticId: id,
    askVariant: raw?.askVariant ? String(raw.askVariant) : undefined,
    counterPricePerDay: Number.isFinite(counter) && counter > 0 ? counter : undefined,
  };
}

/** The tactic id alone - the historical signature, for callers that only score
 *  the move. */
export async function lastTacticId(
  senderEmail: string,
  toDigits: string
): Promise<string | null> {
  return (await lastMove(senderEmail, toDigits))?.tacticId ?? null;
}
