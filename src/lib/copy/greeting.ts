// THE ONE DEFINITION OF "THIS MESSAGE OPENS WITH A GREETING" (W4.7).
//
// Owner report 5, item 3, with three field screenshots of ONE thread:
//
//     us  12:04  "Hi! Do you have a spare scooter for 3 days?"
//     us  12:19  "Hi there! Just checking in - any chance on that better rate?"
//     us  12:41  "Hey there! ok so 250 works for me?"
//
// "The ai agents keep writing 'Hi' every new message in a single thread which
// makes the shop think it's an automatic bot; writing hi or hello more than one
// time is not humanize behavior."
//
// Three different greetings in three consecutive messages is not a person being
// warm - it is a machine rolling dice, and it was literally that: wa-guard's
// `humanizeVariant` matched a leading greeting and substituted a DIFFERENT
// random one on every send. It never removed one and it had no idea where in a
// thread it was.
//
// The regex the old repair used (orchestrator.GREETING_RX) had two holes this
// module closes:
//
//   1. "Hi again!"  ->  "Again! Just checking in..."   The alternation matched
//      the bare "Hi" and left the adverb behind as a sentence of its own. Both
//      hard-coded nudge templates in the app opened exactly that way, so every
//      momentum/recheck message that went through the repair was mangled.
//   2. "Hitting the road tomorrow"  ->  "Tting the road tomorrow".  The trailing
//      `[!,.]*\s*` could match EMPTY, so a greeting word had no right boundary
//      and any message starting with those letters was chopped.
//
// Everything here is deterministic and pure. It runs at the ONE choke point
// every outbound crosses (wa-guard.humanizeForOutbound), so no caller can
// forget it, and it is intentionally boring: the localizer is told the thread
// position too (agents.localizeMessage `greet`), because a regex over English
// can never remove a Thai greeting a translator was ASKED to add.

/**
 * A leading greeting, with a right boundary.
 *
 * `(?:\s+again)?` is the "X again!" form both nudge templates used; the closing
 * group forces punctuation, whitespace or end-of-string after the greeting word
 * so "Hitting", "Hola" inside a word, or "Yohan" can never be clipped.
 */
export const LEADING_GREETING_RX =
  /^\s*(?:good\s+(?:morning|afternoon|evening|day)|hey\s+there|hi\s+there|hello\s+there|heya|hey|hi|hello|hallo|yo)(?:\s+again)?\s*(?:[!,.…\-–—]+\s*|\s+|$)/i;

/**
 * The same question for a message we did NOT write in English.
 *
 * Deliberately a short list of the greetings our own localizer produces for the
 * markets this app actually runs in, not an attempt at every language on earth.
 * It is a SECOND line of defence: the first is telling `localizeMessage` not to
 * write a greeting at all when the thread is already open.
 */
export const LEADING_LOCAL_GREETING_RX =
  /^\s*(?:สวัสดี(?:ครับ|ค่ะ|คะ)?|ยินดี|xin\s+ch[àa]o|ch[àa]o(?:\s+b[aạ]n)?|kumusta(?:\s+po)?|magandang\s+\w+|halo|hai|selamat\s+\w+|hola|buen[oa]s?\s+\w*|ol[áa]|bom\s+dia|boa\s+tarde|bonjour|salut|guten\s+tag|ciao|salve|merhaba|selam|namaste|namaskar|salam|marhaba|ahlan|shalom|שלום|привет|здравствуйте|你好|こんにちは|안녕하세요|สวัสดี)(?:\s+(?:again|krub|ka|po))?\s*[!,.…\-–—]*\s*/iu;

/** Does this message open with a greeting (English or one of the local ones)? */
export function hasLeadingGreeting(text: string): boolean {
  return LEADING_GREETING_RX.test(text ?? "") || LEADING_LOCAL_GREETING_RX.test(text ?? "");
}

/**
 * Remove a leading greeting - the deterministic repair for a message that is
 * NOT the first thing we have ever said to this shop.
 *
 * Never strips a message down to nothing: a bare "Hi!" is a poor message but a
 * blank one is a lost turn, so the original survives. The first letter is
 * re-capitalised because the greeting carried the sentence's capital.
 */
export function stripLeadingGreeting(text: string): string {
  let out = String(text ?? "");
  for (const rx of [LEADING_GREETING_RX, LEADING_LOCAL_GREETING_RX]) {
    if (!rx.test(out)) continue;
    const stripped = out.replace(rx, "");
    if (!stripped.trim()) return out; // never strip a message down to nothing
    out = stripped;
  }
  if (out === text) return out;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
