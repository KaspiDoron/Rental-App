// TRANSLATION OUTPUT VALIDATION - plan I-6b.
//
// The translate route took the model's JSON and ran `parsed.t.map(String)`,
// which has three failure modes that all reached the durable shared dictionary
// and were then rendered to every user of that language:
//
//   1. A JSON `null` in the array became the LITERAL STRING "null" - cached,
//      and shown as a button label.
//   2. Placeholders ({n}, {shop}) were REQUESTED in the prompt but never
//      verified. A model that dropped or renamed one produced a string the
//      naive first-occurrence String.replace could not fill - a button reading
//      "you have  shops left".
//   3. "Will", the product's own assistant, was NOT on the do-not-translate
//      list, and it is a high-frequency English modal verb - so it came back
//      translated as "will" the auxiliary in 13 catalogue strings.
//
// This module rejects a bad translation rather than caching it. Rejecting means
// the source English stays visible for that one string, which is a correct,
// readable fallback - the whole point being that a wrong translation is worse
// than an untranslated one, because the wrong one is invisible until a user
// complains and unfixable while it sits in the cache.
//
// Pure and exported, so the rules are testable without an LLM.

/**
 * Product and brand words that must appear VERBATIM in the translation.
 *
 * "Will" is the load-bearing addition: it is the assistant's name AND a common
 * English auxiliary, so a localiser with no context translates it every time.
 * The others were already named in the prompt; pinning them here makes the
 * prompt's request enforceable instead of merely polite.
 */
export const DO_NOT_TRANSLATE = [
  "WheelDeal",
  "Will",
  "Ultra",
  "Pro",
  "WhatsApp",
  "Google",
  "PayPal",
  "AI",
] as const;

/** Extract the `{placeholder}` tokens from a string, as a sorted multiset. */
export function placeholders(s: string): string[] {
  return (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The longest run of ASCII letters in a string. Used only as a coarse "the
 * model left a brand word intact" check - a translation of a string that
 * CONTAINS a DNT word must still contain that word.
 */
function containsWord(haystack: string, word: string): boolean {
  // Word-ish boundary on both sides so "Pro" does not match inside "Product".
  const re = new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`);
  return re.test(haystack);
}

export interface ValidationResult {
  ok: boolean;
  /** Why it was rejected, for the admin translation panel and tests. */
  reason?: "not-a-string" | "empty" | "placeholder-drift" | "brand-lost" | "too-long" | "too-short";
}

/**
 * The longest a translation may be relative to its source, and the shortest.
 *
 * Real translations expand (German, Finnish) and contract (CJK) a lot, so the
 * bounds are generous - they exist to catch a model that returned an
 * explanation, a refusal, or a single stray character, not to police length.
 */
export const MAX_RATIO = 4;
export const MIN_RATIO = 0.15;

/**
 * Validate one translation against its source. Returns ok:false with a reason
 * rather than throwing, so the caller can drop the pair and keep the source.
 */
export function validateTranslation(source: string, candidate: unknown): ValidationResult {
  // 1. The "null" bug, at the root: anything that is not a string is rejected
  //    before String() can turn it into a truthy label.
  if (typeof candidate !== "string") return { ok: false, reason: "not-a-string" };
  const out = candidate.trim();
  if (!out) return { ok: false, reason: "empty" };
  // The literal word "null"/"undefined" as an entire value is the coerced-null
  // tell; a real translation is never exactly that.
  if (out === "null" || out === "undefined") return { ok: false, reason: "not-a-string" };

  // 2. Placeholders must survive exactly - same tokens, same count.
  if (!sameMultiset(placeholders(source), placeholders(out))) {
    return { ok: false, reason: "placeholder-drift" };
  }

  // 3. A brand word present in the source must be present in the output.
  for (const word of DO_NOT_TRANSLATE) {
    if (containsWord(source, word) && !containsWord(out, word)) {
      return { ok: false, reason: "brand-lost" };
    }
  }

  // 4. Coarse length sanity - catches refusals and explanations, not register.
  const ratio = out.length / Math.max(1, source.length);
  if (ratio > MAX_RATIO) return { ok: false, reason: "too-long" };
  // Very short sources (an emoji, "OK") legitimately map to very short strings,
  // so the floor only applies once the source is long enough for it to mean
  // something.
  if (source.length >= 12 && ratio < MIN_RATIO) return { ok: false, reason: "too-short" };

  return { ok: true };
}
