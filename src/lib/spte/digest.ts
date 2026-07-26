// SPTE memory consolidation / context compression: the rolling ThreadDigest
// absorbs the conversation so history never accumulates in the prompt. Each
// turn the single pass returns <=3 new durable facts; these merge in, oldest
// evicted past a cap. This is what keeps 10 threads x 15 messages inside a lean
// per-turn token budget.

import type { ThreadDigest, TurnArtifact, VerifiedExtraction } from "./types";

const MAX_FACTS = 10;

export function emptyDigest(): ThreadDigest {
  return { facts: [], round: 0 };
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

  // The model's durable notes (deposit terms, condition, tone cues).
  for (const f of artifact.digestPatch) add(f);
  if (artifact.move === "close" || artifact.move === "redirect-close") add("closed - one goodbye sent");

  // Keep the freshest MAX_FACTS (evict oldest).
  const capped = facts.slice(Math.max(0, facts.length - MAX_FACTS));

  return {
    facts: capped,
    quotedPricePerDay:
      verified.found && typeof verified.pricePerDay === "number"
        ? verified.pricePerDay
        : prev.quotedPricePerDay,
    round: prev.round + (artifact.move === "bargain" ? 1 : 0),
    tone: prev.tone,
  };
}
