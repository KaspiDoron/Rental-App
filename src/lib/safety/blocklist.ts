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
// AND A FLOOR HAS TO BE A FLOOR. Proved live with no LLM key configured, the
// old list accepted every one of these with HTTP 200: `fuk`, `f*ck`, `fvck`,
// `phuck`, `a$$hole`, "you are a dick", `retard`, `faggot`, `n1gger`, `whore`
// and "I know where you live". Two whole families were missing - slurs and
// veiled threats - and the third was defeated by a single asterisk, because the
// patterns were matched against the RAW text. Obfuscation is the normal way
// abuse is typed, not an exotic attack, so the text is NORMALISED first
// (see `normalizeAbuseText`) and every pattern is tested against the normalised
// forms as well as the original.
//
// THE TWO SURFACES ARE NOT THE SAME SURFACE, AND THAT IS THE ONE JUDGEMENT
// HERE. Calling a rental shop's bike "useless" or its pricing a "scam" is
// unprofessional and the outbound guard has always refused it. Writing "this
// app is useless, the price radar is a scam" in a BUG REPORT is exactly the
// feedback the owner asked to receive - the report filter must not become a
// complaint filter, or the safest possible feedback page is one that hears
// nothing. So the blunt judgement words stay outbound-only, and the feedback
// floor is profanity, slurs, threats and insults aimed at a person.
//
// The line is drawn at LANGUAGE, never at anger: "this shop screwed me", "the
// scooter was crap", "this whole flow is stupid" and "I want a refund" all pass,
// and there are tests that fail if they ever stop passing.

// ---------------------------------------------------------------------------
// NORMALISATION - what makes this a floor rather than a speed bump.
// ---------------------------------------------------------------------------

/**
 * Character swaps used to smuggle a word past a literal list. Applied before
 * any pattern runs, so `n1gger`, `sh!t`, `a$$hole` and `b4stard` are the words
 * they are plainly meant to be.
 *
 * `a` is deliberately NOT produced from `4`/`@` into the swear stems below -
 * see PROFANITY_PATTERNS - because `f` + `a` + `k` is the word "fake", which a
 * bug report may well contain.
 */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "!": "i",
  "|": "i",
  "3": "e",
  "4": "a",
  "@": "a",
  "5": "s",
  $: "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

/** Separators used INSIDE a word to break a match: `f*ck`, `f.u.c.k`, `a-hole`. */
const SEPARATORS = /[*._\-'"~^`|/\\+=]/g;

/** Zero-width and directional marks - invisible, and they break every pattern. */
const INVISIBLES = /[\u200b-\u200f\u2028\u2029\u2060\ufeff\u00ad]/g;

export interface NormalizedText {
  /** Separators become SPACES, so word boundaries survive: `bad.fuck`. */
  plain: string;
  /** Separators are DELETED, so split words rejoin: `f*ck`, `f.u.c.k`. */
  tight: string;
}

/**
 * Fold a message into the two forms every pattern is tested against.
 *
 * Two forms rather than one because the two obfuscations need opposite
 * treatments: deleting the separator is what rejoins `f.u.c.k`, and keeping it
 * as a space is what preserves the boundary in `broken.fuck`. Doing only one of
 * them lets the other through. Whitespace is never removed - squeezing a whole
 * message into one token is how "the bus hit a wall" becomes a profanity hit.
 */
export function normalizeAbuseText(raw: string): NormalizedText {
  const base = String(raw ?? "")
    .toLowerCase()
    // Strip accents so `fück` folds to `fuck`.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(INVISIBLES, "")
    .replace(/[01345789!|@$]/g, (c) => LEET[c] ?? c)
    // Apostrophes always vanish rather than becoming a space: the patterns are
    // written against `youre` / `ill`, not `you re` / `i ll`.
    .replace(/['\u2018\u2019]/g, "");
  const plain = base.replace(SEPARATORS, " ").replace(/\s+/g, " ").trim();
  const tight = base.replace(SEPARATORS, "").replace(/\s+/g, " ").trim();
  return { plain, tight };
}

// ---------------------------------------------------------------------------
// THE PATTERNS. Written against the NORMALISED text (no apostrophes, leet
// already folded), and every one of them is boundary-anchored - a floor that
// matches mid-word is a floor that refuses "Scunthorpe".
// ---------------------------------------------------------------------------

/** Swearing. Matched on the stem so "fucking"/"shitty" do not slip through. */
export const PROFANITY_PATTERNS: readonly RegExp[] = [
  // f-word, every ordinary disguise: fuck, fuk, fck, fvck, phuck, fuuuck.
  // `[uvo]` and NOT `a`, or this matches the word "fake".
  /\b(?:ph|f)+[uvo]*c*k/i,
  // ...and the `@`/`4` spelling, which normalises to an `a` the class above
  // cannot accept. "fack" and "facking" are not words.
  /\bfack/i,
  // Letter-by-letter: "f u c k". Bounded to two separators per gap so this
  // cannot reach across a sentence.
  /\bf[^a-z0-9]{1,2}u[^a-z0-9]{0,2}c[^a-z0-9]{0,2}k\b/i,
  /\bshit(?:s|ty|e|ed|ting|head|bag|hole)?\b|\bbullshit/i,
  /\bbitch/i,
  /\bass?holes?\b|\bass hole\b|\barseholes?\b/i,
  /\bcunts?\b/i,
  /\bwanker|\btwat\b|\bprick\b/i,
  /\bbastards?\b/i,
  /\bwhores?\b|\bsluts?\b/i,
];

/**
 * Violence and coercion - including the VEILED kind, which is how a threat is
 * actually written. "I know where you live" contains no threatening word at
 * all, and it was the exact string that walked through the old list.
 */
export const THREAT_PATTERNS: readonly RegExp[] = [
  /\bthreat(?:s|en|ens|ened|ening)?\b/i,
  // Directed violence. Bare "kill" is deliberately not here: "I had to kill
  // the app" is an ordinary sentence in a crash report.
  /\b(?:kill|hurt|beat|stab|shoot|smash|destroy|end)\s+(?:you|u|yourself|him|her|them)\b/i,
  // THE LOOKAHEAD IS NOT DECORATION. This list is a SUPERSET for the outbound
  // guard, where "I will find you a better price" and "I will get you two more
  // quotes" are sentences the agent legitimately writes. A threat does not
  // hand you an object; an offer does.
  /\bi(?:ll| will| am going to| am gonna|m gonna)\s+(?:find|hunt|destroy|ruin|end|get|kill|hurt)\s+(?:you|u)\b(?!\s+(?:a|an|the|some|another|better|cheaper|more|two|three|\d))/i,
  /\breport you to\b/i,
  // The veiled family - no violent word required.
  /\b(?:i|we)\s+know\s+where\s+(?:you|u)\s+(?:live|work|are|sleep|stay)\b/i,
  /\bwatch\s+your\s+back\b/i,
  /\byou(?:re| are)\s+(?:a\s+)?dead\b/i,
  // NOTE what is deliberately absent: "coming to your hotel/room/office".
  // Delivery to the traveller is the product - half the rental shops in the
  // corpus say exactly that - so it cannot be a threat pattern at any price.
  /\bburn\s+(?:down\s+)?your\b/i,
  /\bmake\s+(?:you|u)\s+pay\b(?!\s+(?:less|only|just|about|around|by|with|in))/i,
];

/**
 * Slurs and hate speech. A whole missing family: the old list had none of
 * these, so `faggot`, `n1gger` and `retard` were stored verbatim and rendered
 * to the owner. There is no version of this text that is product feedback.
 */
export const HATE_PATTERNS: readonly RegExp[] = [
  /\bnigg(?:er|a|as|ers|ah)\b/i,
  /\bfagg?ots?\b/i,
  /\bretard(?:s|ed)?\b/i,
  /\btrann(?:y|ies)\b/i,
  /\b(?:kikes?|chinks?|spics?|gooks?|wetbacks?|towelheads?)\b/i,
];

/**
 * Insults aimed at a PERSON. Deliberately directed ("you are an idiot"), not
 * bare adjectives, so "this design is stupid" - a real opinion about a real
 * product - is not silently shredded.
 */
export const DIRECTED_INSULT_PATTERNS: readonly RegExp[] = [
  /\byou(?:re| are|r team is| people are|s)?\s+(?:such\s+)?(?:a\s+|an\s+)?(?:complete\s+|total\s+|absolute\s+|fucking\s+)?(idiots?|morons?|clowns?|losers?|stupid|useless|pathetic|incompetent|thie(?:f|ves)|liars?|dick(?:head)?s?|pricks?|scumbags?|scum|jerks?|retards?|bastards?|cunts?|assholes?|arseholes?|wankers?)\b/i,
  /\b(idiots?|morons?)\b[,!.]?\s*(fix|answer|reply|do)\b/i,
];

/** What the FEEDBACK page refuses: swearing, slurs, threats, personal insults. */
export const ABUSE_PATTERNS: readonly RegExp[] = [
  ...PROFANITY_PATTERNS,
  ...THREAT_PATTERNS,
  ...HATE_PATTERNS,
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

/**
 * Does `text` trip any of `patterns`? Empty/blank text never does.
 *
 * Tested against the raw text AND both normalised forms, so a single asterisk
 * can no longer defeat the whole list.
 */
export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const { plain, tight } = normalizeAbuseText(t);
  // `test` on a non-global regex is stateless, so the shared constants above are
  // safe to reuse across calls (a /g flag here would make them emphatically not).
  return patterns.some((rx) => rx.test(t) || rx.test(plain) || (tight !== plain && rx.test(tight)));
}

/** The feedback floor: abuse only, never product criticism. */
export function containsAbuse(text: string): boolean {
  return matchesAny(text, ABUSE_PATTERNS);
}

/** The families, so a refusal can name what it refused. */
export type AbuseKind = "profanity" | "threat" | "hate" | "insult";

/**
 * WHICH family tripped, or null.
 *
 * The floor used to answer a bare boolean, so every deterministic refusal was
 * reported to the reporter as "please send this again without the swearing" -
 * including the ones that were a threat or a slur, where that copy is simply
 * the wrong thing to say. Ordered by seriousness, so a message that is both
 * gets named by its worse half.
 */
export function abuseKind(text: string): AbuseKind | null {
  if (matchesAny(text, THREAT_PATTERNS)) return "threat";
  if (matchesAny(text, HATE_PATTERNS)) return "hate";
  if (matchesAny(text, DIRECTED_INSULT_PATTERNS)) return "insult";
  if (matchesAny(text, PROFANITY_PATTERNS)) return "profanity";
  return null;
}
