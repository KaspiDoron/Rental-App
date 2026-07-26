// Human-output hygiene: every AI-generated string shown to a person (user or
// vendor) passes through here so no markdown artifacts (**, *, `, #, etc.)
// ever reach a human conversation.

/**
 * Strip the legacy "(unverified)" suffix from a shop name. The suffix was a
 * drill-mode identity marker that leaked onto real shops (fixed at the source),
 * but HISTORICAL rows (outbound meta, agent_events, offers) still carry it -
 * this is the display-side purge so it never reaches a card, feed row, queue
 * item, or push notification again.
 */
export function cleanShopName(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s*\(unverified\)\s*$/i, "").trim();
}

export function sanitizeAiText(s: string): string {
  return s
    .replace(/```[a-z]*\n?/gi, "") // code fences
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italics
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*]\s+/gm, "- ") // normalise bullets
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * FINAL outbound scrub for a WhatsApp message, run as the very last step before
 * send. It kills the reported artifact - a LEADING/unpaired asterisk ("good *good
 * day", "qiuck *quick question", an old typo self-correction now removed) - plus
 * unambiguous markdown, WITHOUT the collateral damage of the general
 * sanitizeAiText: it deliberately does NOT touch underscores (they live in URLs /
 * emails / identifiers - "rent_a_bike" must survive) and does NOT strip a
 * single-asterisk PAIR (that would eat "5* and 4*" star ratings). Only fenced/
 * inline code, **bold**, and genuinely dangling asterisks are removed.
 */
export function stripWaFormatting(s: string): string {
  return fixParticlePunctuation(
    s
      .replace(/```[a-z]*\n?/gi, "") // code fences
      .replace(/`([^`]+)`/g, "$1") // inline code -> inner text
      .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** -> inner (double * is unambiguous)
      // Leading/standalone asterisk(s) hugging the START of a word ("*good"):
      .replace(/(^|[\s(])\*+(?=\S)/g, "$1")
      // Trailing asterisk(s) hugging the END of a word ("word*"):
      .replace(/(\S)\*+(?=\s|$)/g, "$1")
      .replace(/`+/g, "") // any surviving stray backticks
      // Collapse the doubled spaces the removals leave behind.
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/**
 * A politeness particle (po / krub / kraap / ka / ka) belongs INSIDE the
 * sentence, never orphaned after its own "!" - the LLM-directive path produced
 * "Hi there! po!" (live evidence). Pull the particle back onto the preceding
 * clause and collapse the doubled terminator: "Hi there! po!" -> "Hi there po!".
 */
export function fixParticlePunctuation(s: string): string {
  return s
    .replace(/([!?.])\s+(po|krub|kraap|krap|ka|kaa|krab)\b([!?.]*)/gi, " $2$3")
    .replace(/\s+([!?.,])/g, "$1") // no space before punctuation
    .replace(/([!?]){2,}/g, "$1") // collapse doubled terminators
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
