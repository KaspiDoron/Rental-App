import { z } from "zod";

// W6.2 - THE TRIAGE VERDICT, VALIDATED.
//
// `triageFeedback` accepted the model's JSON after checking ONE field
// (`typeof v.isRealIssue === "boolean"`) and handed the rest straight back. The
// route then did `verdict.severity.toUpperCase()` in the escalation email
// subject, so a reply that omitted `severity` - a perfectly ordinary thing for
// a small free-tier model to do - threw a TypeError AFTER the row had already
// been inserted. The reporter saw "Something went wrong", no escalation email
// went out, and re-submitting duplicated the row.
//
// The repo already has the pattern for this (lib/semantic/parse.ts): a zod
// schema is what makes an LLM answer usable, and a shape that does not match is
// a failure to REPORT, not an object to pass along. Here the caller cannot
// simply fail - the feedback is real and the row is going in either way - so a
// bad shape is COERCED to a safe, honest default instead of exploding.

export const FeedbackVerdictSchema = z.object({
  isRealIssue: z.boolean(),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1).max(300),
  reason: z.string().max(600),
});

export type ValidFeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

/**
 * Force any triage answer - the model's, the heuristic fallback's, or garbage -
 * into a verdict every consumer can use without a defensive check.
 *
 * `body` supplies the summary when the model gave none, so an escalation email
 * still has a subject a human can read.
 */
export function normalizeVerdict(raw: unknown, body: string): ValidFeedbackVerdict {
  const parsed = FeedbackVerdictSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const r = (raw ?? {}) as Record<string, unknown>;
  const severity = String(r.severity ?? "").toLowerCase();
  const summary = String(r.summary ?? "").trim() || body.trim().slice(0, 80) || "feedback";
  return {
    // An unreadable verdict must not silently DISCARD a report: when we cannot
    // tell, the report is treated as real and reaches a human. The opposite
    // default would make a malformed model answer a silent spam filter.
    isRealIssue: typeof r.isRealIssue === "boolean" ? r.isRealIssue : true,
    severity: severity === "low" || severity === "high" ? severity : "medium",
    summary: summary.slice(0, 300),
    reason: String(r.reason ?? "Triage answer was incomplete - routed for human review.").slice(0, 600),
  };
}
