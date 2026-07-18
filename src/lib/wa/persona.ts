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
  [/\bavailable\b/gi, "free"],
  [/\bassist\b/gi, "help"],
  [/\bcurrently\b/gi, "rn"],
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
