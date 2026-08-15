// Per-user VOICE PERSONA - the core of zero-pattern authenticity.
//
// The strongest tell of a bot fleet is not one weird message - it is a hundred
// "different customers" who all write identically. Real humans are (a)
// self-consistent over time and (b) DIFFERENT from each other. So every user's
// agent gets a stable persona derived from their identity hash: greeting habit,
// punctuation energy, emoji appetite, brevity, sign-off style. The same user
// always sounds like the same person; no two users sound alike.

import "server-only";
import { createHash } from "crypto";

export interface VoiceProfile {
  greeting: string; // how this person tends to open
  signoff: string; // how they tend to close
  energy: "calm" | "warm" | "upbeat"; // punctuation/enthusiasm level
  emoji: "never" | "rare" | "sometimes"; // emoji appetite
  brevity: "very short" | "short" | "chatty"; // message length habit
  quirk: string; // one small personal habit
}

const GREETINGS = [
  "Hi", "Hello", "Hey", "Hey there", "Hi there", "Good day", "Heya",
];
const SIGNOFFS = [
  "Thanks!", "Thank you!", "Thanks a lot!", "Thx!", "Ta!", "Cool thanks!",
];
const ENERGY: VoiceProfile["energy"][] = ["calm", "warm", "upbeat"];
const EMOJI: VoiceProfile["emoji"][] = ["never", "rare", "sometimes"];
const BREVITY: VoiceProfile["brevity"][] = ["very short", "short", "chatty"];
const QUIRKS = [
  "occasionally starts a sentence lowercase, like fast phone typing",
  "sometimes uses a double exclamation when happy",
  "tends to ask questions directly, no filler",
  "often adds a small polite softener like 'if possible' or 'no rush'",
  "sometimes drops the subject pronoun ('Staying nearby, need a scooter')",
  "likes to confirm details back briefly before agreeing",
];

/** Stable persona for one user - same inputs, same human, forever. */
export function voiceProfileFor(key: string): VoiceProfile {
  const h = createHash("sha256").update(`voice:${key.toLowerCase()}`).digest();
  const pick = <T,>(arr: T[], i: number): T => arr[h[i] % arr.length];
  return {
    greeting: pick(GREETINGS, 0),
    signoff: pick(SIGNOFFS, 1),
    energy: pick(ENERGY, 2),
    emoji: pick(EMOJI, 3),
    brevity: pick(BREVITY, 4),
    quirk: pick(QUIRKS, 5),
  };
}

/**
 * Prompt block that makes the LLM WRITE as this specific person.
 *
 * W4.7 - `greeting: false` for every MID-CONVERSATION composer. The persona
 * used to tell the model, in the same system prompt that forbade mid-thread
 * greetings, that this person "usually opens with 'Hey there'". A model handed
 * two contradictory rules obeys the more concrete one, which is why "Hey
 * there!" kept appearing on turn four of a thread. The habit is real and it
 * belongs to the OPENER; after that it is simply wrong.
 */
export function voiceDirectives(v: VoiceProfile, opts?: { greeting?: boolean }): string {
  const opening =
    opts?.greeting === false
      ? "we are MID-CONVERSATION so this message opens with NO greeting at all (never hi/hello/hey, and never a local-language greeting)"
      : `usually opens with "${v.greeting}"`;
  return (
    `WRITE AS THIS SPECIFIC PERSON (stay in character): ${opening}, ` +
    `usually closes with "${v.signoff}". Tone: ${v.energy}. Emoji: ${
      v.emoji === "never"
        ? "never uses emoji"
        : v.emoji === "rare"
        ? "at most one emoji, and only sometimes"
        : "one light emoji when it fits"
    }. Length: ${v.brevity} messages. Habit: ${v.quirk}. ` +
    "Real people are consistent - keep this voice, do not invent a new personality per message."
  );
}
