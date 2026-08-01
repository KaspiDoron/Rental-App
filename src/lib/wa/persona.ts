// Linguistic anti-fingerprinting: make every automated WhatsApp message read
// like a fast-typing traveller haggling on their phone, not a polished bot.
//
// Rental shops that get messaged by many travellers can cluster senders by
// their language signature - identical greetings, corporate sign-offs, perfect
// grammar, the same rebuttal every time. This module is the last-mile scrubber
// that runs on EVERY auto message (whatever the composer produced): it removes
// the bot-tells, casualises the register, and adds bounded human noise. It is
// deterministic-friendly (accepts an injected rand) so tests can pin it.

// Corporate / bot sign-offs a real backpacker never types. Matched at the END
// of the message (optionally on their own trailing line), case-insensitive.
// NOTE: casual closers ("thanks", "thx", "ta") are deliberately NOT here - those
// are human; it is the formal/repetitive ones that fingerprint an automation.
const SIGNOFF_RX = new RegExp(
  "\\s*[\\n\\r]*\\s*(?:" +
    "cheers|best regards|kind regards|warm(?:est)? regards|" +
    "with regards|regards|sincerely(?: yours)?|yours (?:truly|faithfully|sincerely)|" +
    "best wishes|many thanks and regards|thanks and regards|" +
    "looking forward to (?:hearing from you|your reply)|" +
    "thank you for your (?:time|consideration|understanding)|" +
    "have a (?:nice|great|good|lovely) (?:day|one)|" +
    "hope to hear (?:from you )?soon" +
    ")[\\s,.!]*$",
  "i"
);

/** Strip a trailing corporate sign-off. Runs until none remain (stacked ones). */
export function stripBotSpeak(text: string): string {
  let out = text;
  for (let i = 0; i < 3 && SIGNOFF_RX.test(out); i++) {
    out = out.replace(SIGNOFF_RX, "");
  }
  // A dangling "Best," / "Warmly," style comma-tail on its own.
  out = out.replace(/[\n\r]+\s*(best|warmly|thanks again|ciao)\s*,?\s*$/i, "");
  return out.replace(/\s+$/g, "").trim();
}

// Colloquial swaps: nudge formal phrasing toward how a traveller actually texts.
// Applied probabilistically so the SAME source line varies across shops.
//
// A SWAP MAY ONLY CHANGE THE REGISTER, NEVER THE MEANING. That line used to
// include `available -> free`, and on Ko Tao it cost a real booking: the agent
// asked "is that one of the bikes you have free?", the shop read it as a
// request for a free motorbike and answered "My shop doesn't have free
// motorcycles. You should try another shop; maybe they'll give you one" - one
// minute after quoting 180 baht. In every market this app serves, "free" means
// no-cost first and vacant second. A word with two meanings is not a synonym.
//
// The bar for anything added here: it must be unambiguous to a non-native
// English speaker reading it on a phone, in a hurry, in a second language.
const CASUAL_SWAPS: [RegExp, string][] = [
  [/\bI would like to\b/gi, "I wanna"],
  [/\bI would like\b/gi, "I want"],
  [/\bcould you please\b/gi, "can you"],
  [/\bwould it be possible to\b/gi, "can you"],
  [/\bI am interested in\b/gi, "im keen on"],
  [/\bplease let me know\b/gi, "lemme know"],
  [/\bapproximately\b/gi, "around"],
  [/\bregarding\b/gi, "about"],
  [/\bhowever\b/gi, "but"],
  [/\bassist\b/gi, "help"],
  // `currently -> rn` is deliberately NOT here either: "rn" is opaque to a
  // shop owner reading English as a second language, which is the same class
  // of failure as "free" - a register win that costs comprehension.
];

/** casual, imperfect, mobile-typed register. `rand` keeps it testable. */
export function casualize(text: string, rand: () => number = Math.random): string {
  let out = text;
  for (const [rx, to] of CASUAL_SWAPS) {
    if (rand() < 0.55 && rx.test(out)) out = out.replace(rx, to);
  }
  // Drop a leading capital sometimes ("Hey" -> "hey"): fast typers skip shift.
  if (rand() < 0.4) out = out.replace(/^([A-Z])/, (m) => m.toLowerCase());
  // "you" -> "u" once, rarely (not everywhere - that reads as spam).
  if (rand() < 0.25) out = out.replace(/\byou\b/, "u");
  // Occasional dropped apostrophe (im, dont, cant) - a real mobile tell.
  if (rand() < 0.35) out = out.replace(/\b(I'm|don't|can't|it's)\b/, (m) => m.replace("'", ""));
  return out;
}

// A VEHICLE IS NEVER "free". It is available, or it is spare.
//
// Removing the swap above stops US writing it. This stops EVERYTHING writing
// it - the LLM composer, the opener templates, the graph engine, the legacy
// orchestrator - because `personaHumanize` is the one function every auto
// message passes through on its way to the wire (wa-guard.ts, the
// `opts.auto` branch). A rail in one engine would have covered one engine.
//
// Scoped deliberately: only "free" standing next to a vehicle noun, in either
// order, is rewritten. "free delivery", "free helmet" and "free of charge" are
// real offers a shop makes and must survive untouched - the whole point is that
// the no-cost sense is the dominant one.
const VEHICLE_NOUN = "bikes?|scooters?|motorbikes?|motorcycles?|mopeds?|cars?|vehicles?|automatics?";
const FREE_BEFORE_VEHICLE = new RegExp(`\\bfree\\s+(${VEHICLE_NOUN})\\b`, "gi");
const VEHICLE_BEFORE_FREE = new RegExp(`\\b(${VEHICLE_NOUN})\\s+free\\b`, "gi");
// The field sentence put four words between the noun and the adjective - "the
// bikes you have free?" - so adjacency alone would have missed the exact
// message that cost the booking. A possession verb with `free` hanging off the
// end of the clause is the same claim at a distance. Bounded to clause-final
// position on purpose: "we have free delivery" has a noun after it and is a
// real no-cost offer.
const HAVE_FREE_DANGLING = /\b(have|has|had|got|have got)\s+free\s*(?=[?.!,;]|$)/gi;
// "...when one might be free again?" - a deterministic FALLBACK template shipped
// this exact sentence, and it fires precisely when the LLM is unavailable, i.e.
// when the prompt rule above cannot help. Two more predicative shapes, both of
// which can only mean vacancy:
//   * "free again" - a price never becomes free again; a vehicle does.
//   * a pronoun subject with a copula: "one is free", "any are free",
//     "it might be free". A no-cost offer names the thing that is free
//     ("delivery is free"), so a bare pronoun here is always the vacancy sense.
const FREE_AGAIN = /\bfree\s+again\b/gi;
const PRONOUN_IS_FREE =
  /\b(one|any|it|that|some|they|these|those)\s+((?:is|are|was|were|might be|will be|would be|becomes?|gets?)\s+)free\b/gi;

/**
 * Rewrite the one ambiguity that cost a live booking on Ko Tao: the agent asked
 * "is that one of the bikes you have free?" meaning vacant, and the shop -
 * which had quoted 180 baht a minute earlier - read it as asking for a bike at
 * no cost and told us to try somewhere else.
 *
 * "Spare" carries the vacancy sense and nothing else, so this is a rewrite
 * rather than a rejection: the sentence was otherwise correct.
 */
export function deAmbiguateFree(text: string): string {
  return text
    .replace(FREE_BEFORE_VEHICLE, (_m, noun: string) => `spare ${noun}`)
    .replace(VEHICLE_BEFORE_FREE, (_m, noun: string) => `${noun} spare`)
    .replace(HAVE_FREE_DANGLING, (_m, verb: string) => `${verb} spare`)
    .replace(FREE_AGAIN, "available again")
    .replace(PRONOUN_IS_FREE, (_m, subj: string, verb: string) => `${subj} ${verb}available`);
}

// Sparing, warm, context-free emojis a customer trying to lock a rental uses.
const HUMAN_EMOJI = ["👍", "🤙", "🙏", "😊", "👌", "🙂"];

/**
 * The full last-mile persona pass for an AUTO message: strip bot-speak, then
 * (probabilistically) casualise and add ONE warm emoji when none is present.
 * Bounded and idempotent-ish; safe to run on any composed or template message.
 */
export function personaHumanize(text: string, rand: () => number = Math.random): string {
  let out = stripBotSpeak(text);
  out = casualize(out, rand);
  // AFTER casualize, not before: this has to be the last word on the subject
  // whatever the composer or the swaps produced.
  out = deAmbiguateFree(out);
  // At most one emoji, and only sometimes - not every message (that is itself a
  // pattern). Skip if the message already carries one.
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/u.test(out);
  if (!hasEmoji && rand() < 0.45) {
    const e = HUMAN_EMOJI[Math.floor(rand() * HUMAN_EMOJI.length)];
    // Sometimes leading, usually trailing - vary the position too.
    out = rand() < 0.2 ? `${e} ${out}` : `${out.replace(/\s+$/, "")} ${e}`;
  }
  return out.trim();
}
