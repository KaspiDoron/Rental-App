// THE DETERMINISTIC FLOOR FOR ABUSIVE LANGUAGE.
//
// This list lived as a private `const BLOCKLIST` inside `runSafety` in
// agents.ts, where it guarded OUTBOUND WhatsApp messages and nothing else. The
// feedback pipeline - the one surface a stranger can type into with no session
// and no shop on the other end - had no profanity screen at all: not in the
// route, not in the triage prompt, and a negative triage verdict blocked
// nothing, so abusive text was stored and rendered verbatim to the owner.
//
// The owner asked for a "safe words feedback page". That needs the same list,
// so the list is here rather than copied - one vocabulary, two callers, and a
// word added for one surface protects the other by construction.
//
// A BLOCKLIST IS THE FLOOR, NEVER THE CEILING. It is yesterday's vocabulary by
// definition (this repo's own doctrine - see lib/semantic/parse.ts), so callers
// run a model FIRST and use this as the answer that cannot fail: it needs no
// provider, no network and no budget, so there is no outage in which abuse gets
// through unexamined.
//
// THE TWO SURFACES ARE NOT THE SAME SURFACE, AND THAT IS THE ONE JUDGEMENT
// HERE. Calling a rental shop's bike "useless" or its pricing a "scam" is
// unprofessional and the outbound guard has always refused it. Writing "this
// app is useless, the price radar is a scam" in a BUG REPORT is exactly the
// feedback the owner asked to receive - the report filter must not become a
// complaint filter, or the safest possible feedback page is one that hears
// nothing. So the blunt judgement words stay outbound-only, and the feedback
// floor is profanity, threats and insults aimed at a person.

/** Swearing. Matched on the stem so "fucking"/"shitty" do not slip through. */
export const PROFANITY_PATTERNS: readonly RegExp[] = [
  /\bf+u+c+k/i,
  /\bsh[i1]t\b|\bsh[i1]tty\b/i,
  /\bbitch/i,
  /\bassholes?\b/i,
  /\bcunts?\b/i,
  /\bwanker|\btwat\b|\bprick\b/i,
  /\bbastards?\b/i,
];

/** Violence and coercion. */
export const THREAT_PATTERNS: readonly RegExp[] = [
  /\b(threat|kill|hurt you|report you to)\b/i,
  /\bi('| wi)ll (find|hunt|destroy|ruin) you\b/i,
];

/**
 * Insults aimed at a PERSON. Deliberately directed ("you are an idiot"), not
 * bare adjectives, so "this design is stupid" - a real opinion about a real
 * product - is not silently shredded.
 */
export const DIRECTED_INSULT_PATTERNS: readonly RegExp[] = [
  /\byou(?:'re| are|r team is| people are|s)?\s+(?:such\s+)?(?:a\s+|an\s+)?(?:complete\s+|total\s+|absolute\s+|fucking\s+)?(idiots?|morons?|clowns?|losers?|stupid|useless|pathetic|incompetent|thie(?:f|ves)|liars?)\b/i,
  /\b(idiots?|morons?)\b[,!.]?\s*(fix|answer|reply|do)\b/i,
];

/** What the FEEDBACK page refuses: swearing, threats, personal insults. */
export const ABUSE_PATTERNS: readonly RegExp[] = [
  ...PROFANITY_PATTERNS,
  ...THREAT_PATTERNS,
  ...DIRECTED_INSULT_PATTERNS,
];

/**
 * Blunt judgement words. Unprofessional to send to a SHOP; ordinary and welcome
 * in a bug report, which is why they are not in `ABUSE_PATTERNS`. Preserved
 * verbatim from the original outbound list.
 */
export const JUDGEMENT_PATTERNS: readonly RegExp[] = [
  /\b(scam|fraud|idiot|stupid|useless)\b/i,
];

/**
 * Patterns about coaxing PERSONAL contact details out of someone. Relevant on
 * the outbound-message path; deliberately NOT part of the feedback screen,
 * where "email me at..." is a normal thing for a reporter to write.
 */
export const CONTACT_PRYING_PATTERNS: readonly RegExp[] = [
  /(phone|whatsapp|email|address).{0,20}(personal|home|private)/i,
];

/** The full outbound screen - a superset of the feedback floor, unchanged in
 *  effect from the private list that used to live in agents.ts. */
export const OUTBOUND_BLOCKLIST: readonly RegExp[] = [
  ...ABUSE_PATTERNS,
  ...JUDGEMENT_PATTERNS,
  ...CONTACT_PRYING_PATTERNS,
];

/** Does `text` trip any of `patterns`? Empty/blank text never does. */
export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // `test` on a non-global regex is stateless, so the shared constants above are
  // safe to reuse across calls (a /g flag here would make them emphatically not).
  return patterns.some((rx) => rx.test(t));
}

/** The feedback floor: abuse only, never product criticism. */
export function containsAbuse(text: string): boolean {
  return matchesAny(text, ABUSE_PATTERNS);
}
