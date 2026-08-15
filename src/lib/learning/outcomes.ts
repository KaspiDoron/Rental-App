import "server-only";

// THE LEARNING PANEL WAS FED BY A DEAD ENGINE.
//
// `recordOutcome` is the core learning update: it moves a tactic's win rate and
// its rolling average discount, and the admin agent-memory panel renders the
// result. It had exactly one caller - graph/judge.ts - and since P1.1 routed
// every thread wakeup through SPTE, that judge no longer runs for the turns
// that do the negotiating. So the panel kept rendering numbers, and the numbers
// stopped being about anything the live agents did.
//
// The fix is not to relabel the panel. Every fact the update needs is already
// on the thread: the move we played last turn, the price the shop was on before
// it, and the price it just quoted. What was missing is the join between them.
//
// ATTRIBUTION IS ONE TURN LATE, and that is correct rather than a compromise: a
// negotiation move's result is the shop's NEXT answer. Crediting a move at the
// moment it is sent would score our own intentions.

import { recordOutcome } from "../memory";

export interface MoveResult {
  /** Did the shop come down after this move? */
  won: boolean;
  /** How far, as a percentage of the previous quote. 0 when it did not move. */
  discountPct: number;
}

/**
 * What the shop's new quote says about the move that preceded it.
 *
 * Returns null when there is nothing to learn from - no previous quote, no new
 * quote, or a quote that is not a real number. Silence beats a fabricated
 * outcome: a tactic scored against a missing price is worse than an unscored
 * one, because it looks like evidence.
 */
export function judgeMove(
  previousQuote: number | null | undefined,
  newQuote: number | null | undefined
): MoveResult | null {
  const before = Number(previousQuote);
  const after = Number(newQuote);
  if (!Number.isFinite(before) || before <= 0) return null;
  if (!Number.isFinite(after) || after <= 0) return null;
  // A price that went UP is not a loss for our tactic - it is usually a
  // different vehicle, a different duration, or a correction. Scoring it as a
  // negative would teach the wrong lesson from a misread.
  if (after > before) return null;
  if (after === before) return { won: false, discountPct: 0 };
  return {
    won: true,
    discountPct: Number((((before - after) / before) * 100).toFixed(1)),
  };
}

/**
 * Credit (or debit) the move we played last turn with what the shop just said.
 *
 * Best-effort and never throws: a learning update must not be able to fail a
 * negotiation turn.
 */
export async function learnFromReply(input: {
  tacticId: string | null | undefined;
  previousQuote: number | null | undefined;
  newQuote: number | null | undefined;
  /**
   * The PHRASING arm the scored move was written in (negotiation/ask-variant).
   *
   * THE VARIANT LABEL IS THE WHOLE POINT OF THE OWNER'S A/B. This function is
   * already the precise answer to "did the shop concede, and by how much" - the
   * one thing it could not answer was WHICH phrasing earned it, because the
   * identifier it credits is the MOVE NAME ("bargain"), identical in both arms.
   * A second `bargain#<arm>` row makes the two populations separable without
   * disturbing the move-level statistic anything else reads.
   */
  askVariant?: string | null;
}): Promise<MoveResult | null> {
  const tacticId = String(input.tacticId ?? "").trim();
  if (!tacticId) return null;
  const result = judgeMove(input.previousQuote, input.newQuote);
  if (!result) return null;
  try {
    recordOutcome(tacticId, result.won, result.discountPct);
    // The arm gets its own row, in ADDITION to the move's. Replacing the move
    // row would silently change what every existing panel is measuring; this
    // adds a population without moving one.
    const arm = String(input.askVariant ?? "").trim();
    if (arm) recordOutcome(`${tacticId}#${arm}`, result.won, result.discountPct);
  } catch {
    /* best-effort - the panel is an observation, not a rail */
  }
  return result;
}
