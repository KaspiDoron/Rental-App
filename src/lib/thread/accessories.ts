// WHAT THE SHOP ACTUALLY SAID ABOUT EACH THING THE TRAVELLER ASKED FOR.
//
// The request travels: helmets, a phone mount, a GoPro bracket, delivery to the
// hotel. It goes out in the opening message and then vanishes from the app's
// model of the world. The card shows a price. The booking sheet showed the
// REQUEST with green ticks beside it. Nowhere did anything record that the shop
// said "helmet yes, no GoPro mount", and so a traveller could lock a deal
// believing a mount was coming.
//
// This is the per-item record. It is deliberately keyed by the traveller's own
// words - "GoPro mount", not a category from a list we maintain - because the
// whole point of reading the reply with a model instead of a keyword bucket is
// that the vocabulary is theirs, not ours.

export type AccessoryState = "confirmed" | "refused" | "unknown";

export interface AccessoryStatus {
  /** The traveller's own wording, echoed exactly. */
  item: string;
  state: AccessoryState;
  /** What the shop wants for it on top, when they named a number. */
  extraCost?: number | null;
  /** The shop's own sentence, so a chip can be traced to something real. */
  quote?: string | null;
  /** When it was decided - a later message can change a shop's mind. */
  at?: number;
}

/** The parser's verdict shape, kept separate from the stored one. */
export interface AccessoryVerdictInput {
  item: string;
  verdict: "confirmed" | "refused" | "unmentioned";
  extraCost?: number | null;
  quote?: string | null;
  confidence?: number;
}

/**
 * Below this the model is guessing, and a guess about whether a helmet is
 * included is worse than an honest "we don't know yet" - the traveller can ask.
 */
export const MIN_CONFIDENCE = 0.5;

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Fold this turn's verdicts into what the thread already knew.
 *
 * The rules, and why:
 *
 *   * `unmentioned` NEVER overwrites a decision. A shop that confirmed helmets
 *     in message two does not un-confirm them by writing about the deposit in
 *     message three, and that is exactly what a naive last-write-wins merge
 *     would do on every subsequent turn.
 *   * A decision DOES overwrite an earlier decision. Shops change their minds,
 *     find a second helmet, or discover the mount is broken. The newest word
 *     from the shop is the true one.
 *   * A low-confidence verdict is discarded entirely rather than stored as a
 *     weak signal, because every surface that reads this will render it as a
 *     fact and none of them will carry the confidence through.
 *   * Items the traveller never asked for are dropped. The model is told which
 *     items to judge; anything else is an invention, and an invented "confirmed
 *     GPS" on a booking screen is the failure mode this file exists to prevent.
 */
export function mergeAccessoryVerdicts(
  previous: AccessoryStatus[] | undefined,
  verdicts: AccessoryVerdictInput[],
  opts: { requested: string[]; at: number }
): AccessoryStatus[] {
  const allowed = new Map(opts.requested.map((r) => [norm(r), r]));
  const out = new Map<string, AccessoryStatus>();

  // Start from the request, so an untouched item is present and honestly unknown
  // rather than absent (absent renders as "we never asked", which is false).
  for (const item of opts.requested) {
    out.set(norm(item), { item, state: "unknown" });
  }
  for (const p of previous ?? []) {
    const key = norm(p.item);
    if (!allowed.has(key)) continue;
    out.set(key, { ...p, item: allowed.get(key)! });
  }

  for (const v of verdicts) {
    const key = norm(v.item ?? "");
    if (!allowed.has(key)) continue;
    if (v.verdict === "unmentioned") continue;
    if (typeof v.confidence === "number" && v.confidence < MIN_CONFIDENCE) continue;
    out.set(key, {
      item: allowed.get(key)!,
      state: v.verdict,
      extraCost: typeof v.extraCost === "number" ? v.extraCost : null,
      quote: v.quote ?? null,
      at: opts.at,
    });
  }

  return [...out.values()];
}

/** Is anything the traveller asked for still unanswered? Drives the ask-once probe. */
export function unansweredAccessories(status: AccessoryStatus[] | undefined): string[] {
  return (status ?? []).filter((s) => s.state === "unknown").map((s) => s.item);
}

/** A one-line summary for the card. Null when there is nothing to say. */
export function accessorySummary(status: AccessoryStatus[] | undefined): string | null {
  const list = status ?? [];
  if (!list.length) return null;
  const yes = list.filter((s) => s.state === "confirmed").length;
  const no = list.filter((s) => s.state === "refused").length;
  if (!yes && !no) return null;
  const parts: string[] = [];
  if (yes) parts.push(`${yes} confirmed`);
  if (no) parts.push(`${no} not available`);
  return parts.join(", ");
}
