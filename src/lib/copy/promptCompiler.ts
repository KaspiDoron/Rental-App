// The PROMPT COMPILER (Module 4) - turns a matrix draw into (a) a complete
// cold-outreach opener, and (b) structural style directives for the LLM
// composers on ongoing bargain/reply turns. Pure + deterministic: the same
// (threadId, vendorId, nonce) always compiles the same text.

import type { StructuredRFQ } from "../types";
import { drawStyle, type CopySeed } from "./matrix";

/** The traveller-facing vehicle wording (mirrors the intent of buildMessage). */
export function vehicleWording(rfq: StructuredRFQ): string {
  if (rfq.vehicleClass === "car") {
    const bits = [
      rfq.transmission !== "any" ? rfq.transmission : "",
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      "car",
      rfq.seats ? `${rfq.seats} seats` : "",
    ].filter(Boolean);
    return bits.join(" ");
  }
  const cc = rfq.engineSizeCc ? ` (${rfq.engineSizeCc}cc)` : "";
  const trans =
    rfq.transmission === "manual" ? "manual " : rfq.transmission === "automatic" ? "automatic " : "";
  return `${trans}${rfq.vehicleClass === "scooter" ? "scooter" : "motorbike"}${cc}`;
}

function applyContraction(text: string, style: "contracted" | "plain" | "mixed"): string {
  if (style === "contracted") {
    return text
      .replace(/\bI am\b/g, "I'm")
      .replace(/\bwhat is\b/gi, (m) => (m[0] === "W" ? "What's" : "what's"))
      .replace(/\bdo not\b/g, "don't");
  }
  if (style === "plain") {
    return text.replace(/\bI'm\b/g, "I am").replace(/\bWhat's\b/g, "What is").replace(/\bwhat's\b/g, "what is");
  }
  return text; // mixed - leave as authored
}

/**
 * Compile one COMPLETE cold-outreach opener. Every structural dimension comes
 * from the seeded matrix, so a 40-shop batch (one seed per vendor) produces 40
 * different skeletons - the direct kill for the "same message to every shop"
 * spam fingerprint.
 */
export function compileOpener(rfq: StructuredRFQ, seed: CopySeed, region?: string): string {
  const s = drawStyle(seed, region);
  const vehicle = s.vehiclePhrase(vehicleWording(rfq));
  const duration = s.durationPhrase(Math.max(1, rfq.durationDays));
  const slangGreet = s.slang && s.slang !== "salamat" ? ` ${s.slang}` : "";
  const slangOff = s.slang === "salamat" ? "Salamat!" : s.signOff;

  const intro = s.selfIntro
    ? `${s.selfIntro} ${vehicle} ${duration}.`
    : `${vehicle[0].toUpperCase()}${vehicle.slice(1)} ${duration} - possible?`;

  let body: string;
  if (s.order === "greet-intro-ask") {
    body = `${s.greeting}${slangGreet} ${intro} ${s.ask}`;
  } else if (s.order === "greet-ask-intro") {
    body = `${s.greeting}${slangGreet} ${s.ask} ${s.selfIntro ? `(${vehicle} ${duration})` : `${vehicle} ${duration}.`}`;
  } else {
    // "intro-first": a terse, substance-led opener (a busy traveller getting
    // straight to the point) - the warmth is the appended sign-off + emoji, not
    // an opening pleasantry. B2 fix: the old form appended the greeting AFTER
    // the ask with a hard-coded " btw!" literal, producing the exact production
    // defect "...best price? Hi there btw! Thanks!". This variant now simply
    // omits the greeting word, keeping it structurally distinct from the two
    // greet-first orders without ever misplacing a greeting.
    body = `${intro} ${s.ask}`;
  }

  let out = applyContraction(body, s.contraction).replace(/\s{2,}/g, " ").trim();
  if (slangOff) out = `${out} ${slangOff}`;
  if (s.emoji) out = `${out} ${s.emoji}`;
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Structural style directives for the LLM composers (bargain/reply turns):
 * injected via extraDirectives so every turn in every thread carries its own
 * deterministic shape - sentence order, contraction, emoji rule, slang hint -
 * instead of the model's favorite default skeleton.
 */
export function compileStyleDirectives(seed: CopySeed, region?: string): string {
  const s = drawStyle(seed, region);
  const parts = [
    `STYLE (this message only): open ${s.greeting === "" ? "without a greeting" : `in the spirit of "${s.greeting}" (but NOT verbatim - we are mid-conversation, so no literal greeting word)`}.`,
    s.order === "intro-first"
      ? "Lead with the substance, pleasantries after."
      : "One warm beat first, then the substance.",
    s.contraction === "contracted"
      ? "Use natural contractions (I'm, what's)."
      : s.contraction === "plain"
      ? "Avoid contractions - slightly formal-simple English."
      : "Mix contractions naturally.",
    s.emoji ? `End with exactly one ${s.emoji} (no other emoji).` : "No emoji this time.",
    s.slang ? `You may include the local word "${s.slang}" once, naturally.` : "",
    "Never reuse the sentence structure of your previous messages in this chat.",
  ].filter(Boolean);
  return parts.join(" ");
}
