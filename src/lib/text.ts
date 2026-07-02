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
