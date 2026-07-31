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

/**
 * The traveller's extras as one readable clause: "a child seat and a top box".
 *
 * Bounded on purpose. Three items is a request; eight is a shopping list that
 * buries the price question the message exists to ask, and the field accepts
 * 240 characters of anything.
 */
export function extrasClause(rfq: StructuredRFQ): string {
  const items = (rfq.accessories ?? [])
    .map((a) => String(a ?? "").trim().replace(/\s{2,}/g, " "))
    .filter(Boolean)
    .slice(0, 3)
    .map((a) => (a.length > 40 ? a.slice(0, 40).trim() : a));
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
  // A politeness PARTICLE (po / krub / ka) attaches to the greeting only. The
  // regional THANK-YOU (Salamat! / Cảm ơn! / gender-matched Thai) is a terminal
  // sign-off ONLY - it can never be glued onto a greeting (the "Hello! cam on"
  // bug). Thanks wins the sign-off slot when present.
  const greet = s.particle ? s.greeting.replace(/!+$/, "") + ` ${s.particle}!` : s.greeting;
  const signOff = s.regionalThanks ?? s.signOff;

  const intro = s.selfIntro
    ? `${s.selfIntro} ${vehicle} ${duration}.`
    : `${vehicle[0].toUpperCase()}${vehicle.slice(1)} ${duration} - possible?`;

  let body: string;
  if (s.order === "greet-intro-ask") {
    body = `${greet} ${intro} ${s.ask}`;
  } else if (s.order === "greet-ask-intro") {
    body = `${greet} ${s.ask} ${s.selfIntro ? `(${vehicle} ${duration})` : `${vehicle} ${duration}.`}`;
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

  // WHAT ELSE THE TRAVELLER ASKED FOR. Until now this opener rendered the
  // vehicle and the duration and stopped, and because it REPLACES whatever the
  // client built (outreach/route.ts), a request for a child seat or a phone
  // mount was silently dropped on its way to every shop. It goes after the ask
  // so the price question stays the message's point.
  const extras = extrasClause(rfq);
  if (extras) body = `${body} ${s.extrasPhrase(extras)}`;

  let out = applyContraction(body, s.contraction).replace(/\s{2,}/g, " ").trim();
  if (signOff) out = `${out} ${signOff}`;
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
    s.particle ? `You may add the polite particle "${s.particle}" to your greeting, once.` : "",
    s.regionalThanks ? `You may close with the local thank-you "${s.regionalThanks}" (at the END only).` : "",
    "Never reuse the sentence structure of your previous messages in this chat.",
  ].filter(Boolean);
  return parts.join(" ");
}
