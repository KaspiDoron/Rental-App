// SPTE memory consolidation / context compression: the rolling ThreadDigest
// absorbs the conversation so history never accumulates in the prompt. Each
// turn the single pass returns <=3 new durable facts; these merge in, oldest
// evicted past a cap. This is what keeps 10 threads x 15 messages inside a lean
// per-turn token budget.

import type { ConfirmSubject, ThreadDigest, TurnArtifact, VerifiedExtraction } from "./types";

const MAX_FACTS = 10;

export function emptyDigest(): ThreadDigest {
  return { facts: [], round: 0 };
}

/**
 * THE HALF OF THE DIGEST THAT IS DURABLE.
 *
 * Everything else on ThreadDigest (firmCount, depositKnown, options, the
 * ledger, lastOutbound) is RE-DERIVED from the thread's own rows every turn -
 * "the conversation is the state" - so persisting it would only create stale
 * copies that can disagree with the messages. These five cannot be derived:
 * the model's durable notes, the quote a shop gave and never restated, how many
 * times we pushed, the tone we read, and which confirming questions we have
 * already spent. They are what `buildDigest` seeds from.
 */
export function persistableDigest(d: ThreadDigest): Partial<ThreadDigest> {
  return {
    facts: d.facts.slice(-MAX_FACTS),
    ...(typeof d.quotedPricePerDay === "number" ? { quotedPricePerDay: d.quotedPricePerDay } : {}),
    round: d.round,
    ...(d.tone ? { tone: d.tone } : {}),
    ...(d.confirmAsked?.length ? { confirmAsked: d.confirmAsked } : {}),
    ...(d.awaitingConfirmation ? { awaitingConfirmation: d.awaitingConfirmation } : {}),
    // The once-ever price-watch bound (owner report 5 #9). Durable or it is not
    // a bound at all - an in-memory flag would re-arm on every cold start.
    ...(d.priceWatchArmed ? { priceWatchArmed: true } : {}),
  };
}

/** Read a stored digest back, defensively - the column is free-form JSON that
 *  older rows do not have at all. */
export function digestFromStored(stored: unknown): ThreadDigest {
  const base = emptyDigest();
  const s = (stored ?? null) as Partial<ThreadDigest> | null;
  if (!s || typeof s !== "object") return base;
  return {
    ...base,
    facts: Array.isArray(s.facts) ? s.facts.filter((f) => typeof f === "string").slice(-MAX_FACTS) : [],
    quotedPricePerDay:
      typeof s.quotedPricePerDay === "number" && s.quotedPricePerDay > 0
        ? s.quotedPricePerDay
        : undefined,
    round: typeof s.round === "number" && s.round >= 0 ? s.round : 0,
    tone: s.tone,
    confirmAsked: Array.isArray(s.confirmAsked)
      ? (s.confirmAsked.filter((x) => typeof x === "string") as ConfirmSubject[])
      : undefined,
    awaitingConfirmation:
      s.awaitingConfirmation && typeof s.awaitingConfirmation === "object"
        ? s.awaitingConfirmation
        : null,
    // ABSENT means not armed, so a row written before this field existed reads
    // as "no watch yet" rather than as a watch that already happened.
    priceWatchArmed: s.priceWatchArmed === true ? true : undefined,
  };
}

/**
 * Merge a turn's outcome into the durable digest: append the model's fact patch,
 * fold in verified price/decline signals deterministically (never trust the LLM
 * for numbers), bump the round when we bargained, cap + evict oldest.
 */
export function mergeDigest(
  prev: ThreadDigest,
  artifact: TurnArtifact,
  verified: VerifiedExtraction
): ThreadDigest {
  const facts = [...prev.facts];
  const add = (f: string) => {
    const t = f.trim();
    if (t && !facts.some((x) => x.toLowerCase() === t.toLowerCase())) facts.push(t);
  };

  // Deterministic, verified signals first (these outrank any LLM claim).
  if (verified.found && typeof verified.pricePerDay === "number") {
    add(`quoted ${verified.pricePerDay}${verified.currency ? " " + verified.currency : ""}/day`);
  }
  if (verified.declined) add("shop declined / walked away");
  // Only a REAL mismatch. `hasClosed()` scans these facts, so writing this on a
  // merely-ambiguous reply permanently muted the thread.
  if (verified.wrongVehicle) add("shop does not offer the requested vehicle");
  if (verified.vehicleUnclear) add("which vehicle this price is for is not confirmed yet");
  for (const o of verified.options ?? []) {
    add(`option: ${o.label} at ${o.pricePerDay}${o.currency ? " " + o.currency : ""}/day`);
  }

  // A SHOP THAT SENT US ELSEWHERE IS A CLOSED THREAD TOO. Without this the
  // one-warm-goodbye rule (`hasClosed`) could not see a graceful close, so the
  // next event on the thread would offer a second goodbye.
  if (verified.deflected) add("shop pointed us elsewhere - not dealing");

  // The model's durable notes (deposit terms, condition, tone cues).
  for (const f of artifact.digestPatch) add(f);
  if (
    artifact.move === "farewell" ||
    artifact.move === "redirect-close" ||
    artifact.move === "graceful-close"
  ) {
    add("closed - one goodbye sent");
  }

  // Keep the freshest MAX_FACTS (evict oldest).
  const capped = facts.slice(Math.max(0, facts.length - MAX_FACTS));

  // THE ASK-ONCE BOUND ON THE THIRD LEDGER STATE. A confirming question is
  // legal exactly once per subject; this is the record that makes "once" mean
  // anything, and it only means anything because the digest is now persisted.
  const confirmSubject = artifact.move === "confirm" ? artifact.confirmSubject : undefined;
  const confirmAsked = confirmSubject
    ? [...new Set([...(prev.confirmAsked ?? []), confirmSubject])]
    : prev.confirmAsked;

  // WHAT THE CARD SAYS WHILE WE WAIT. Set the moment the question goes out;
  // held while the fact is still reported as unsettled; cleared as soon as it
  // is not, so a card can never claim we are double-checking something the
  // shop has since made plain.
  const stillUnsure = (s: ConfirmSubject) => (verified.uncertain ?? []).some((u) => u.subject === s);
  const awaitingConfirmation = confirmSubject
    ? {
        subject: confirmSubject,
        question:
          (verified.uncertain ?? []).find((u) => u.subject === confirmSubject)?.question ??
          artifact.message ??
          "",
      }
    : prev.awaitingConfirmation && stillUnsure(prev.awaitingConfirmation.subject)
      ? prev.awaitingConfirmation
      : null;

  return {
    facts: capped,
    quotedPricePerDay:
      verified.found && typeof verified.pricePerDay === "number"
        ? verified.pricePerDay
        : prev.quotedPricePerDay,
    round: prev.round + (artifact.move === "bargain" ? 1 : 0),
    tone: prev.tone,
    confirmAsked,
    awaitingConfirmation,
  };
}
