// The PROMPT COMPILER (Module 4) - turns a matrix draw into (a) a complete
// cold-outreach opener, and (b) structural style directives for the LLM
// composers on ongoing bargain/reply turns. Pure + deterministic: the same
// (threadId, vendorId, nonce) always compiles the same text.

import type { StructuredRFQ } from "../types";
import { drawStyle, nDays, type CopySeed } from "./matrix";

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

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * "2026-08-12" -> "12 Aug". Returns "" for anything unparseable.
 *
 * NEVER numeric. In the target region 8/12 reads as 12 August to some shops and
 * 8 December to others, and a confidently wrong date is worse than no date -
 * the traveller turns up to a bike that was reserved for the wrong week.
 *
 * Parsed as a plain calendar triple rather than through Date's timezone
 * handling: `new Date("2026-08-12")` is midnight UTC, which is 11 Aug in every
 * timezone west of Greenwich. The rental date is a wall-clock fact about the
 * shop's calendar, not an instant.
 */
export function formatRentalDate(iso?: string): string {
  if (!iso) return "";
  const m = String(iso).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${day} ${MONTHS[month - 1]}`;
}

/**
 * The dates clause: a range when both ends are known, otherwise the start
 * alone, otherwise nothing at all. Never invents a return date - deriving one
 * from durationDays and stating it as fact is how a shop ends up holding a
 * vehicle for a day the traveller never asked for.
 */
function datesClause(
  rfq: StructuredRFQ,
  s: { datePhrase: (f: string) => string; dateRangePhrase: (f: string, t: string) => string },
  days: number
): { text: string; supersedesDuration: boolean } {
  const from = formatRentalDate(rfq.startDate);
  if (!from) return { text: "", supersedesDuration: false };
  const to = formatRentalDate(rfq.returnDate);
  // THE RANGE MUST CARRY ITS DAY COUNT (W4.1, owner report 5 #2).
  //
  // The range used to stand alone, on the reasoning that it already says how
  // long and that "12 Aug to 15 Aug 3 days total" reads like a form letter.
  // Two things broke because of it:
  //
  //   1. A WRONG duration became INVISIBLE. The traveller picked 3 days, the
  //      profiler invented 1, and twenty shops read "16 Aug until 17 Aug" -
  //      a plausible sentence that contradicted nothing. Stating both facts
  //      means a wrong one argues with itself on the wire, where the traveller
  //      and the shop can both see it.
  //   2. The thread lost its TEXT PROVENANCE. `citedDurationDays` (the promise
  //      fallback for a thread whose structured rfq was lost) can only read a
  //      counted day number - a range gives it nothing, so promiseOf returned
  //      null and the anchor could be rewritten by any later send. That is the
  //      mid-thread flip.
  //
  // The register objection was fair, so the count rides in parentheses the way
  // a person actually texts it - "16 Aug to 19 Aug (3 days)" - and, since the
  // range is now DERIVED from the duration (lib/rental-window.deriveReturnDate),
  // the two can no longer disagree in the first place.
  if (to && to !== from) {
    return { text: `${s.dateRangePhrase(from, to)} (${nDays(days)})`, supersedesDuration: true };
  }
  return { text: s.datePhrase(from), supersedesDuration: false };
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
 * Put a politeness particle where a NATIVE writer puts it: at the end of a
 * sentence, inside its final punctuation ("Thanks krub!", "Salamat po!",
 * "How much per day po?").
 *
 * W4.7b: it used to be glued onto the greeting - "Hi there po!", "Hi ka!" - a
 * hybrid nobody writes in either language, and a bot tell in the opposite
 * direction from the repeated greeting the owner reported. Thai and Filipino
 * particles attach to a SENTENCE, not to an English hello; that is also exactly
 * what compileStyleDirectives has been telling the LLM composers to do all
 * along, so the two halves of the copy engine now agree.
 */
function attachParticle(sentence: string, particle: string): string {
  const m = sentence.match(/^([\s\S]*?)([!?.…]+)\s*$/);
  return m ? `${m[1]} ${particle}${m[2]}` : `${sentence} ${particle}`;
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
  // THE GREETING IS NEVER THE PARTICLE'S HOST (W4.7b). The regional THANK-YOU
  // (Salamat! / Cảm ơn! / gender-matched Thai) was already terminal-only - it
  // can never be glued onto a greeting (the "Hello! cam on" bug) - and the
  // particle now follows the same rule for the same reason: it rides the
  // closing sign-off when there is one ("Salamat po!", "Thanks krub!") and the
  // ask sentence when there is not ("How much per day po?"). Thanks still wins
  // the sign-off slot when present, and a thank-you that ALREADY carries the
  // particle ("Khop khun krub!") never gets a second one.
  const greet = s.greeting;
  let ask = s.ask;
  let signOff = s.regionalThanks ?? s.signOff;
  if (s.particle) {
    const alreadyHas = new RegExp(`(^|\\s)${s.particle}\\b`, "i").test(signOff);
    if (signOff && !alreadyHas) signOff = attachParticle(signOff, s.particle);
    else if (!signOff) ask = attachParticle(ask, s.particle);
  }

  // A VEHICLE PHRASE IS A PREDICATE, SO GIVE IT A SUBJECT.
  //
  // `vehicle` is always a verb phrase - "after a scooter", "need a scooter" -
  // and the compiler dropped one in as a standalone sentence whenever the
  // self-intro slot came up empty. That is the message the owner photographed:
  // "Can I ask your daily price? after an automatic scooter (125cc) for 3 days
  // straight." A sentence fragment, from a stranger, as a first contact.
  //
  // The subject travels with the phrasing (matrix.ts) because "I'm after" and
  // "I need" do not take the same one - which is exactly why a single
  // hard-coded prefix could not have fixed this.
  // THE DATES GO WITH THE DURATION, NOT AFTER THE ASK.
  //
  // "I need a scooter from 12 Aug for 3 days. What's your best daily rate?" is
  // a question a shop can answer in one line. The same message without the
  // date is not a question at all - it is a rate-card request, which is what a
  // reseller sends, and it is the single biggest reason our openers went
  // unanswered. Unanswered new chats are the exact quantity WhatsApp meters.
  const dates = datesClause(rfq, s, Math.max(1, rfq.durationDays));
  const when = !dates.text
    ? duration
    : dates.supersedesDuration
      ? dates.text
      : `${dates.text} ${duration}`;

  const standalone = `${s.vehicleSubject} ${vehicle} ${when}.`;
  const intro = s.selfIntro ? `${s.selfIntro} ${vehicle} ${when}.` : standalone;

  let body: string;
  if (s.order === "greet-intro-ask") {
    body = `${greet} ${intro} ${ask}`;
  } else if (s.order === "greet-detail-ask") {
    // Detail first, no self-intro at all - a traveller who gets to the point
    // and is still a person about it.
    body = `${greet} ${standalone} ${ask}`;
  } else if (s.order === "intro-ask-plain") {
    // Two sentences, no greeting: the shortest shape that is still whole.
    body = `${standalone} ${ask}`;
  } else if (s.order === "greet-ask-intro") {
    // The detail follows the ask as its own SENTENCE. The old form used
    // `s.selfIntro` as a boolean and threw its text away, keeping the
    // fragment either way - in brackets when an intro existed, bare when it
    // did not.
    body = `${greet} ${ask} ${intro}`;
  } else {
    // "intro-first": a terse, substance-led opener (a busy traveller getting
    // straight to the point) - the warmth is the appended sign-off + emoji, not
    // an opening pleasantry. B2 fix: the old form appended the greeting AFTER
    // the ask with a hard-coded " btw!" literal, producing the exact production
    // defect "...best price? Hi there btw! Thanks!". This variant now simply
    // omits the greeting word, keeping it structurally distinct from the two
    // greet-first orders without ever misplacing a greeting.
    body = `${intro} ${ask}`;
  }

  // WHAT ELSE THE TRAVELLER ASKED FOR. Until now this opener rendered the
  // vehicle and the duration and stopped, and because it REPLACES whatever the
  // client built (outreach/route.ts), a request for a child seat or a phone
  // mount was silently dropped on its way to every shop. It goes after the ask
  // so the price question stays the message's point.
  // A ONE-WAY DROP-OFF IS A PRICE FACT, AND IT WAS NEVER LEAVING THE APP.
  //
  // Same defect as the accessories one above, found later and one degree worse:
  // `rfq.oneWayDropOff` survived the profiler and then reappeared only at
  // BOOKING time. Nothing in between told the shop, so the whole negotiation
  // priced a round-trip rental, that number was presented as the deal, and the
  // one-way fee arrived at handover. Accessories at least had a probe; this has
  // no compensating path anywhere in spte/ or graph/.
  //
  // Ahead of the extras because it changes the number the message is asking for.
  const dropOff = String(rfq.oneWayDropOff ?? "").trim().slice(0, 60);
  if (dropOff) body = `${body} ${s.dropOffPhrase(dropOff)}`;

  const extras = extrasClause(rfq);
  if (extras) body = `${body} ${s.extrasPhrase(extras)}`;

  // ...and whether they deliver at all, when that is what the traveller asked
  // for. NO ADDRESS: the stay location is gated by the disclosure rail and is
  // never sent unprompted. Last, because it is the softest of the three and the
  // engine's fulfillment-probe can still recover it if the shop ignores it.
  if (rfq.fulfillment === "hotel-delivery") body = `${body} ${s.deliveryPhrase()}`;

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
    // W4.7: THE DEAD BRANCH IS GONE. `s.greeting === ""` was never true -
    // neither GREETINGS nor PLAIN_GREETINGS has an empty entry - so this
    // directive ALWAYS named a greeting to the model and then asked it not to
    // write one verbatim. The composers this compiles for (bargain/reply turns)
    // are mid-conversation by construction, so the honest instruction is the
    // one the branch could never reach.
    "STYLE (this message only): we are MID-CONVERSATION - open with NO greeting at all (no hi/hello/hey, and no local-language greeting either); go straight into the substance.",
    s.order === "intro-first"
      ? "Lead with the substance, pleasantries after."
      : "One warm beat first, then the substance.",
    s.contraction === "contracted"
      ? "Use natural contractions (I'm, what's)."
      : s.contraction === "plain"
      ? "Avoid contractions - slightly formal-simple English."
      : "Mix contractions naturally.",
    s.emoji ? `End with exactly one ${s.emoji} (no other emoji).` : "No emoji this time.",
    // ...and the particle rode the greeting, which re-opened the same door.
    // In Thai/Filipino the politeness particle attaches to ANY sentence, so it
    // keeps its warmth without smuggling an opener back in.
    s.particle
      ? `You may add the polite particle "${s.particle}" once, at the end of a sentence - never as a greeting.`
      : "",
    s.regionalThanks ? `You may close with the local thank-you "${s.regionalThanks}" (at the END only).` : "",
    "Never reuse the sentence structure of your previous messages in this chat.",
  ].filter(Boolean);
  return parts.join(" ");
}
