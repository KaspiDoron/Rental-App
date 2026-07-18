// Human-output hygiene: every AI-generated string shown to a person (user or
// vendor) passes through here so no markdown artifacts (**, *, `, #, etc.)
// ever reach a human conversation.

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
 * send. sanitizeAiText only strips PAIRED markdown; a real shop message went out
 * as "good *good day" / "qiuck *quick question" - a LEADING/unpaired asterisk (an
 * old typo self-correction, now removed) that sanitizeAiText left untouched. This
 * kills every residual formatting artifact so the shop only ever sees clean human
 * text: unpaired/leading/trailing `*`, stray backticks, and dangling underscores,
 * then collapses the doubled spaces they leave behind.
 */
export function stripWaFormatting(s: string): string {
  return sanitizeAiText(s)
    // Leading/standalone asterisks before a word ("... *good" / "*quick"):
    .replace(/(^|[\s(])\*+(?=\S)/g, "$1")
    // Trailing stray asterisks ("word*"):
    .replace(/(\S)\*+(?=\s|$)/g, "$1")
    // Any surviving backticks, and unpaired underscores hugging a word:
    .replace(/`+/g, "")
    .replace(/(^|\s)_+(?=\S)/g, "$1")
    .replace(/(\S)_+(?=\s|$)/g, "$1")
    // Collapse the doubled spaces the removals leave behind.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
