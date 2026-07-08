// The AI agent ecosystem. Every agent degrades gracefully to a deterministic
// heuristic when no LLM key is configured, so the product is always functional.

import "server-only";
import { chat, extractJson } from "./ai";
import type {
  StructuredRFQ,
  VehicleClass,
  Transmission,
  Fulfillment,
  Vendor,
  Offer,
} from "./types";
import { getTactics, recordOutcome } from "./memory";

// ---------------------------------------------------------------------------
// Profiler Agent - free text → structured, vendor-ready RFQ
// ---------------------------------------------------------------------------

export async function runProfiler(
  input: string,
  durationDaysHint?: number
): Promise<StructuredRFQ> {
  const system =
    "You are a procurement assistant for a vehicle-rental savings app. " +
    "Convert the traveller's raw request into a JSON RFQ. Respond with ONLY " +
    "JSON matching this TypeScript type: { vehicleClass: 'car'|'motorbike'|'scooter'," +
    " engineSizeCc?: number, seats?: number, carType?: 'economy'|'sedan'|'suv'|'van'|'luxury'|'any'," +
    " transmission: 'automatic'|'manual'|'any', maxMileageKm?: number," +
    " durationDays: number, accessories: string[], fulfillment: 'hotel-delivery'|'in-store'|'any'," +
    " notes?: string, vendorMessage: string }. For cars use seats/carType (not engineSizeCc); " +
    "for scooters/motorbikes use engineSizeCc. The vendorMessage must read like a " +
    "natural, friendly first-person WhatsApp message from the traveller asking for " +
    "availability and the best daily price - authentic and human, plain text, no " +
    "markdown. Write as a REAL human traveller messaging a shop - never mention " +
    "an app, assistant, bot or automation of any kind.";

  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: input },
  ]);

  if (llm) {
    const parsed = extractJson<StructuredRFQ>(llm);
    if (parsed && parsed.vehicleClass) {
      return normalizeRFQ(parsed, input, durationDaysHint);
    }
  }
  return heuristicRFQ(input, durationDaysHint);
}

function normalizeRFQ(
  rfq: StructuredRFQ,
  input: string,
  durationHint?: number
): StructuredRFQ {
  return {
    vehicleClass: (["car", "motorbike", "scooter"].includes(rfq.vehicleClass)
      ? rfq.vehicleClass
      : "car") as VehicleClass,
    engineSizeCc: rfq.vehicleClass === "car" ? undefined : rfq.engineSizeCc,
    seats: rfq.vehicleClass === "car" ? rfq.seats : undefined,
    carType: rfq.vehicleClass === "car" ? rfq.carType : undefined,
    transmission: (["automatic", "manual", "any"].includes(rfq.transmission)
      ? rfq.transmission
      : "any") as Transmission,
    maxMileageKm: rfq.maxMileageKm,
    durationDays: rfq.durationDays || durationHint || 3,
    accessories: Array.isArray(rfq.accessories) ? rfq.accessories.slice(0, 8) : [],
    fulfillment: (["hotel-delivery", "in-store", "any"].includes(rfq.fulfillment)
      ? rfq.fulfillment
      : "any") as Fulfillment,
    notes: rfq.notes,
    vendorMessage: rfq.vendorMessage || buildMessage(rfq, input),
  };
}

function heuristicRFQ(input: string, durationHint?: number): StructuredRFQ {
  const t = input.toLowerCase();
  const vehicleClass: VehicleClass = /scooter|vespa|moped/.test(t)
    ? "scooter"
    : /bike|motor|cc\b|125|150|scoot/.test(t)
    ? "motorbike"
    : "car";

  const ccMatch = t.match(/(\d{2,4})\s*cc/);
  const mileageMatch = t.match(/(\d[\d,\.]{2,})\s*(k|km|kms|kilomet)/);
  const daysMatch = t.match(/(\d+)\s*(day|days|night|nights|week)/);
  // Car-specific: seats ("5 seats", "7-seater") and body type.
  const seatsMatch = t.match(/(\d)\s*(?:-)?\s*seat/);
  const seats = seatsMatch ? parseInt(seatsMatch[1], 10) : undefined;
  const carType: StructuredRFQ["carType"] = /suv|4x4|jeep/.test(t)
    ? "suv"
    : /van|minivan|people mover/.test(t)
    ? "van"
    : /luxury|premium|bmw|mercedes|audi/.test(t)
    ? "luxury"
    : /sedan|saloon/.test(t)
    ? "sedan"
    : /economy|cheap|small|compact/.test(t)
    ? "economy"
    : "any";

  const accessories: string[] = [];
  if (/phone|mount|holder/.test(t)) accessories.push("phone mount");
  if (/helmet/.test(t)) accessories.push("helmet");
  if (/gps|navigation/.test(t)) accessories.push("GPS");
  if (/child|baby|infant/.test(t)) accessories.push("child seat");
  if (/box|storage|top case/.test(t)) accessories.push("storage box");

  let durationDays = durationHint || 3;
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10);
    durationDays = /week/.test(daysMatch[2]) ? n * 7 : n;
  }

  const rfq: StructuredRFQ = {
    vehicleClass,
    engineSizeCc: vehicleClass === "car" ? undefined : ccMatch ? parseInt(ccMatch[1], 10) : undefined,
    seats: vehicleClass === "car" ? seats : undefined,
    carType: vehicleClass === "car" ? carType : undefined,
    transmission: /manual|stick/.test(t)
      ? "manual"
      : /auto/.test(t)
      ? "automatic"
      : "any",
    maxMileageKm: mileageMatch
      ? parseInt(mileageMatch[1].replace(/[,\.]/g, ""), 10)
      : undefined,
    durationDays,
    accessories,
    fulfillment: /deliver|hotel|lobby/.test(t)
      ? "hotel-delivery"
      : /pickup|store|shop/.test(t)
      ? "in-store"
      : "any",
    notes: undefined,
    vendorMessage: "",
  };
  rfq.vendorMessage = buildMessage(rfq, input);
  return rfq;
}

function vehicleTerm(v: VehicleClass): string {
  return v === "scooter"
    ? "automatic scooter"
    : v === "motorbike"
    ? "manual motorcycle"
    : "car";
}

function buildMessage(rfq: StructuredRFQ, raw: string): string {
  // Authentic first-person message from the traveller (honest about the app).
  const parts: string[] = [];
  parts.push("Hi! I'm staying nearby and looking to rent");
  const spec: string[] = [`a ${vehicleTerm(rfq.vehicleClass)}`];
  if (rfq.vehicleClass === "car") {
    // Cars: seats, body type and transmission matter (not engine cc).
    if (rfq.carType && rfq.carType !== "any") spec.push(rfq.carType);
    if (rfq.seats) spec.push(`${rfq.seats} seats`);
    if (rfq.transmission !== "any") spec.push(rfq.transmission);
  } else {
    if (rfq.engineSizeCc) spec.push(`${rfq.engineSizeCc}cc`);
    if (rfq.transmission !== "any") spec.push(rfq.transmission);
    if (rfq.maxMileageKm) spec.push(`under ${rfq.maxMileageKm.toLocaleString()} km`);
  }
  parts.push(`${spec.join(", ")} for ${rfq.durationDays} day(s).`);
  if (rfq.accessories.length)
    parts.push(`I'd also need: ${rfq.accessories.join(", ")}.`);
  if (rfq.fulfillment === "hotel-delivery")
    parts.push("Delivery to my hotel would be ideal.");
  parts.push("Is it available, and what's your best daily price? Thanks!");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Safety Guardrail Agent - filters outbound custom messages
// ---------------------------------------------------------------------------

export interface SafetyVerdict {
  allowed: boolean;
  reason?: string;
  suggestion?: string;
}

const BLOCKLIST = [
  /\b(f[uck]{2,}|sh[i1]t|bitch|asshole)\b/i,
  /\b(scam|fraud|idiot|stupid|useless)\b/i,
  /\b(threat|kill|hurt you|report you to)\b/i,
  /(phone|whatsapp|email|address).{0,20}(personal|home|private)/i,
];

export async function runSafety(message: string): Promise<SafetyVerdict> {
  const trimmed = message.trim();
  if (!trimmed) return { allowed: false, reason: "Message is empty." };
  if (trimmed.length > 600)
    return { allowed: false, reason: "Message is too long (max 600 chars)." };

  // Fast local screen first.
  for (const rx of BLOCKLIST) {
    if (rx.test(trimmed)) {
      return {
        allowed: false,
        reason:
          "This message contains language that could be unprofessional or harmful. Please rephrase.",
      };
    }
  }

  const system =
    "You are a communication safety filter for messages a traveller sends to " +
    "rental vendors. Block anything harmful, harassing, discriminatory, " +
    "reputation-damaging, or that shares private data. Reply ONLY as JSON: " +
    '{ "allowed": boolean, "reason"?: string, "suggestion"?: string }.';

  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: trimmed },
  ]);

  if (llm) {
    const verdict = extractJson<SafetyVerdict>(llm);
    if (verdict && typeof verdict.allowed === "boolean") return verdict;
  }
  // No LLM available and it passed the local screen.
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Adaptive Bargaining Agent - composes real negotiation messages to SEND to
// the vendor. It never invents a price: prices come only from vendor replies.
// It learns from the shared tactic playbook and from real bargaining
// transcripts the owner teaches it, and it matches its English level to the
// region (simple, clear English for regions where English is a second
// language; natural fluent English elsewhere). Output is always plain text.
// ---------------------------------------------------------------------------

// Common rental-destination countries -> local currency, matched against the
// geocoded region string so the agent bargains in the money the shop uses.
const REGION_CURRENCY: [RegExp, string][] = [
  [/thai|\bthailand\b/i, "THB"],
  [/\bisrael\b/i, "ILS"],
  [/\bindonesia|\bbali\b/i, "IDR"],
  [/\bvietnam\b/i, "VND"],
  [/\bindia\b/i, "INR"],
  [/\bjapan\b/i, "JPY"],
  [/\bphilippin/i, "PHP"],
  [/\bmalaysia\b/i, "MYR"],
  [/\bturkey|\btürkiye/i, "TRY"],
  [/\bmexico\b/i, "MXN"],
  [/\bunited kingdom|\bengland|\bscotland|\bwales/i, "GBP"],
  [/\beuro|\bspain|\bitaly|\bfrance|\bgermany|\bportugal|\bgreece|\bnetherlands/i, "EUR"],
  [/\bunited states|\busa\b|\bu\.s\./i, "USD"],
];

/** Best-guess local currency for a geocoded region string (undefined if unknown). */
export function currencyForRegion(region?: string): string | undefined {
  if (!region) return undefined;
  for (const [re, cur] of REGION_CURRENCY) if (re.test(region)) return cur;
  return undefined;
}

/** Format money in the LOCAL rental currency (never force dollars). */
export function money(amount: number, currency?: string): string {
  const c = (currency || "USD").toUpperCase();
  if (c === "USD") return `$${Math.round(amount)}`;
  const symbols: Record<string, string> = { EUR: "€", GBP: "£", THB: "฿", ILS: "₪", JPY: "¥", INR: "₹" };
  return symbols[c] ? `${symbols[c]}${Math.round(amount)}` : `${Math.round(amount)} ${c}`;
}

export async function composeBargain(opts: {
  rfq: StructuredRFQ;
  vendor: Vendor;
  currentPricePerDay?: number;
  rivalPricePerDay?: number;
  region?: string;
  round: number;
  // The LOCAL rental currency where the shop is (e.g. THB) - the agent must
  // bargain in THIS currency, never convert to dollars.
  currency?: string;
  // Ultra feature: bargain in the shop's LOCAL language, street-smart style.
  localLanguage?: boolean;
  // Ask-once discipline: the EXACT target to ask for (anchored to the market
  // floor for the area) and the floor itself - the agent may NEVER go below
  // the floor. Absurd lowballs (70 THB/day scooters) kill deals and trust.
  targetPricePerDay?: number;
  floorPricePerDay?: number;
  // Recent conversation, oldest first, so the agent never re-asks anything
  // the shop already answered.
  history?: string;
}): Promise<{ message: string; tacticId: string; tacticLabel: string; english?: string }> {
  const cur = opts.currency || currencyForRegion(opts.region) || "USD";
  // Sane target: the market floor when we know it, otherwise a modest 15% cut.
  // Clamped so we never ask below the floor or below 60% of the quote.
  const quoted = opts.currentPricePerDay;
  let target = opts.targetPricePerDay;
  if (!target && quoted) {
    target = Math.round(quoted * 0.85);
  }
  if (target && quoted) {
    const lowest = Math.max(opts.floorPricePerDay ?? 0, Math.round(quoted * 0.6));
    if (target < lowest) target = lowest;
    if (target >= quoted) target = undefined; // quote already at/below target
  }
  const tactics = getTactics();
  const tactic = tactics[Math.min(opts.round, tactics.length - 1)] ?? tactics[0];

  // Training examples: durable (Supabase) first, then this instance's memory.
  const { listTraining } = await import("./memory");
  const { sbSelect } = await import("./runtime-config");
  const durable = await sbSelect<{ text: string }>(
    "agent_training",
    "select=text&order=created_at.desc&limit=4"
  );
  const examples = [
    ...durable.map((d) => d.text),
    ...listTraining().map((t) => t.text),
  ];
  const training = Array.from(new Set(examples)).slice(0, 4).join("\n---\n");

  const spec = `${opts.rfq.engineSizeCc ? opts.rfq.engineSizeCc + "cc " : ""}${vehicleTerm(
    opts.rfq.vehicleClass
  )} for ${opts.rfq.durationDays} day(s)`;

  const system =
    "You write ONE short WhatsApp message from a real human traveller chatting " +
    "with a rental shop. Rules: plain text only, no markdown, no asterisks, no " +
    "emoji spam (max one), 1-3 sentences, warm and polite, never robotic, never " +
    "mention an app or assistant. Never invent prices we were not given. " +
    "ASK-ONCE DISCIPLINE: this is our ONE and ONLY price ask for this shop - " +
    "make it friendly and easy to say yes to, and make clear we're happy either " +
    "way. Never pressure, never repeat a question the shop already answered. " +
    (opts.history
      ? "Conversation so far (oldest first) - do NOT re-ask anything answered here:\n" +
        opts.history +
        "\n"
      : "") +
    `Preferred tactic: "${tactic.label}" (${tactic.script}). ` +
    (target
      ? `THE ASK: ask if ${money(target, cur)}/day is possible for the ${opts.rfq.durationDays}-day rental - this number is anchored to the real local market floor. NEVER propose a number lower than ${money(Math.max(opts.floorPricePerDay ?? target, Math.round((quoted ?? target) * 0.6)), cur)} - unrealistic lowballs insult the shop. `
      : "Do NOT propose any specific number - just warmly ask for their best price. ") +
    `CRITICAL MONEY RULE: talk about price ONLY in ${cur} - the shop's own local currency. Never write a dollar sign or convert to USD unless ${cur} is USD. Match the numbers the shop uses. ` +
    (opts.localLanguage && opts.region
      ? `CRITICAL: think and write NATIVELY in the main local language of ${opts.region} from the first word - never compose in English and translate. Use the casual street register a savvy local uses at the market: local haggling phrases, local currency habits, natural slang (respectful, never rude). Short and punchy. `
      : `Write in street-smart conversational English - the way real travellers haggle in chat: casual, warm, a little cheeky, contractions, no formal business tone. ` +
        (opts.region
          ? `The shop is in ${opts.region}; if English is a second language there, keep sentences extra short and simple. `
          : "")) +
    (training
      ? "Learn tone and moves from these REAL past bargains by the owner:\n" + training
      : "");

  const user =
    `Vehicle: ${spec}. Currency: ${cur}. ` +
    (quoted ? `They quoted ${money(quoted, cur)}/day. ` : "No quote yet. ") +
    (opts.rivalPricePerDay
      ? `A nearby shop offered ${money(opts.rivalPricePerDay, cur)}/day. `
      : "") +
    (target
      ? `Write our single friendly ask for ${money(target, cur)}/day. All amounts in ${cur}.`
      : `Write one friendly message asking their best price. All amounts in ${cur}.`);

  // When bargaining in the LOCAL language, ask for BOTH the local message and
  // a short plain-English gloss (as JSON) so the traveller can read what their
  // agent is saying on their behalf.
  const localSystem = opts.localLanguage
    ? system +
      ' Reply ONLY as JSON: { "message": "<the local-language message>", "english": "<a short plain-English translation of it>" }.'
    : system;

  const llm = await chat([
    { role: "system", content: localSystem },
    { role: "user", content: user },
  ]);

  const { sanitizeAiText } = await import("./text");
  if (llm) {
    if (opts.localLanguage) {
      const parsed = extractJson<{ message?: string; english?: string }>(llm);
      if (parsed?.message) {
        return {
          message: sanitizeAiText(parsed.message),
          english: parsed.english ? sanitizeAiText(parsed.english) : undefined,
          tacticId: tactic.id,
          tacticLabel: tactic.label,
        };
      }
    }
    return {
      message: sanitizeAiText(llm),
      tacticId: tactic.id,
      tacticLabel: tactic.label,
    };
  }

  // Deterministic fallback built from the learned tactic script.
  const filled = tactic.script
    .replace("{target}", target ? money(target, cur) : "a better rate")
    .replace("{rival}", opts.rivalPricePerDay ? money(opts.rivalPricePerDay, cur) : "a lower price")
    .replace("{vehicle}", vehicleTerm(opts.rfq.vehicleClass))
    .replace("{days}", String(opts.rfq.durationDays));
  return { message: sanitizeAiText(filled), tacticId: tactic.id, tacticLabel: tactic.label };
}

/** Record a bargaining outcome so the playbook keeps learning. */
export function learnOutcome(tacticId: string, won: boolean, discountPct: number) {
  recordOutcome(tacticId, won, Math.max(0, Math.min(60, discountPct)));
}

/** Market-Rate Analyst Agent - estimates a fair local rate for the spec. */
export function marketRateFor(vendor: Vendor, rfq: StructuredRFQ): number {
  const classBase =
    rfq.vehicleClass === "car" ? 32 : rfq.vehicleClass === "motorbike" ? 16 : 11;
  const ccBump = rfq.engineSizeCc ? Math.max(0, (rfq.engineSizeCc - 125) / 125) * 4 : 0;
  const durationDiscount = rfq.durationDays >= 7 ? 0.85 : rfq.durationDays >= 3 ? 0.93 : 1;
  return Math.round((classBase + ccBump) * durationDiscount);
}

/** Vendor Sentiment Agent - infers responsiveness/warmth as a 0..1 score. */
export function sentimentFor(vendor: Vendor, round: number): number {
  const base = (vendor.rating - 3.5) / 1.4; // rating → 0..1-ish
  const warmth = Math.min(1, Math.max(0.1, base + round * 0.08));
  return Number(warmth.toFixed(2));
}

// ---------------------------------------------------------------------------
// Offer Extraction Agent - reads vendor replies (text AND price-list images),
// and never passes a price to the user unless it is certain the price matches
// the exact requested vehicle. When unsure it produces a clarification message
// for the vendor instead.
// ---------------------------------------------------------------------------

export interface ExtractedOffer {
  found: boolean;
  pricePerDay?: number;
  currency?: string;
  vehicleDescription?: string;
  matchesSpec: boolean;
  confidence: "high" | "medium" | "low";
  clarifyMessage?: string;
}

export async function extractOffer(
  rfq: StructuredRFQ,
  text: string,
  images: { mime: string; base64: string }[] = [],
  history?: string
): Promise<ExtractedOffer> {
  const { chatVision } = await import("./ai");
  const spec = `${rfq.engineSizeCc ? rfq.engineSizeCc + "cc " : ""}${
    rfq.vehicleClass === "scooter"
      ? "automatic scooter"
      : rfq.vehicleClass === "motorbike"
      ? "manual motorcycle"
      : "car"
  }${rfq.maxMileageKm ? `, under ${rfq.maxMileageKm} km` : ""}`;

  const system =
    "You extract rental price offers from a vendor's reply (text and/or a photo " +
    "of a price list). The traveller asked for: " +
    spec +
    ". Reply ONLY as JSON: { \"found\": boolean, \"pricePerDay\": number, " +
    '"currency": string, "vehicleDescription": string, "matchesSpec": boolean, ' +
    '"confidence": "high"|"medium"|"low", "clarifyMessage": string }. ' +
    "matchesSpec is true ONLY if the price clearly refers to the exact requested " +
    "vehicle. Combine the reply with the conversation history: if the vehicle " +
    "and daily price are both clear from the thread as a whole, set matchesSpec " +
    "true and confidence high. Only when something is genuinely still unknown, " +
    "write a short, polite clarifyMessage - and it must NEVER repeat a question " +
    "the vendor already answered anywhere in the thread." +
    (history
      ? "\nConversation so far (oldest first):\n" + history
      : "");

  // Vision path (handles price-list photos) when Gemini is available.
  if (images.length > 0) {
    const out = await chatVision(system, text || "See attached price list.", images);
    if (out) {
      const parsed = extractJson<ExtractedOffer>(out);
      if (parsed && typeof parsed.found === "boolean") return normalizeExtraction(parsed, spec);
    }
    return {
      found: false,
      matchesSpec: false,
      confidence: "low",
      clarifyMessage: `Thanks for the photo! Could you confirm in text the daily price for the ${spec}? Just want to be sure we quote the right vehicle.`,
    };
  }

  // Text path via any configured LLM.
  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: text },
  ]);
  if (llm) {
    const parsed = extractJson<ExtractedOffer>(llm);
    if (parsed && typeof parsed.found === "boolean") return normalizeExtraction(parsed, spec);
  }

  // Heuristic fallback: find a price, but never auto-verify it.
  const m = text.match(/(?:\$|usd|idr|rp|eur|€|thb|฿)?\s?(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)\s*(?:\/|per\s*)?(?:day|d\b)/i);
  if (m) {
    return {
      found: true,
      pricePerDay: parseFloat(m[1].replace(/,/g, "")),
      currency: "USD",
      matchesSpec: false,
      confidence: "medium",
      clarifyMessage: `Great, thank you! Just to confirm: is that the daily price for the ${spec} exactly? Once you confirm I'll pass it to the traveller.`,
    };
  }
  return {
    found: false,
    matchesSpec: false,
    confidence: "low",
    clarifyMessage: `Could you share your best daily price for the ${spec}? Thank you!`,
  };
}

function normalizeExtraction(e: ExtractedOffer, spec: string): ExtractedOffer {
  const conf = ["high", "medium", "low"].includes(e.confidence) ? e.confidence : "low";
  const verifiedEnough = e.found && e.matchesSpec && conf === "high";
  return {
    ...e,
    confidence: conf,
    clarifyMessage: verifiedEnough
      ? undefined
      : e.clarifyMessage ||
        `Thanks! Could you confirm the exact daily price for the ${spec}?`,
  };
}

// ---------------------------------------------------------------------------
// Feedback Triage Agent - keeps real bugs, filters spam before it emails staff
// ---------------------------------------------------------------------------

export interface FeedbackVerdict {
  isRealIssue: boolean;
  severity: "low" | "medium" | "high";
  summary: string;
  reason: string;
}

const NOISE = [
  /^(hi|hey|hello|test+|asdf|qwerty|lol|nice|cool|great app|love it)\b/i,
  /(buy followers|crypto|casino|loan|seo services|http:\/\/|https:\/\/)/i,
];

export async function triageFeedback(
  category: string,
  text: string
): Promise<FeedbackVerdict> {
  const trimmed = text.trim();

  // Cheap local screen: too short or obvious noise/marketing.
  const tooShort = trimmed.length < 12;
  const noise = NOISE.some((rx) => rx.test(trimmed));

  const system =
    "You triage product feedback for a rental app. Decide if a submission is a " +
    "GENUINE bug or usability flaw worth a developer's time, versus spam, praise, " +
    "gibberish, or vague noise. Reply ONLY as JSON: " +
    '{ "isRealIssue": boolean, "severity": "low"|"medium"|"high", ' +
    '"summary": string, "reason": string }. summary is a one-line issue title.';

  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: `Category: ${category}\nFeedback: ${trimmed}` },
  ]);

  if (llm) {
    const v = extractJson<FeedbackVerdict>(llm);
    if (v && typeof v.isRealIssue === "boolean") return v;
  }

  // Heuristic fallback.
  if (tooShort || noise) {
    return {
      isRealIssue: false,
      severity: "low",
      summary: trimmed.slice(0, 60) || "empty",
      reason: tooShort ? "Too short to be actionable." : "Looks like spam or noise.",
    };
  }
  const hasSignal =
    /(bug|crash|error|broken|doesn'?t|not work|can'?t|fail|freeze|wrong|slow|missing|blank|stuck|glitch|typo|overlap|cut ?off)/i.test(
      trimmed
    );
  return {
    isRealIssue: hasSignal,
    severity: /(crash|broken|can'?t|fail|freeze|stuck)/i.test(trimmed)
      ? "high"
      : "medium",
    summary: trimmed.slice(0, 60),
    reason: hasSignal
      ? "Contains a concrete problem description."
      : "No concrete issue detected; queued for review.",
  };
}

/** Feedback Writer Agent - turns rough notes into a clear report. */
export async function writeFeedback(
  category: string,
  notes: string
): Promise<string> {
  const system =
    "You clean up a short product feedback/bug note. Output EXACTLY 2 to 3 " +
    "sentences. Each sentence MUST be 8 words or fewer. Fix spelling and grammar, " +
    "keep the user's exact meaning, never invent facts or steps they did not " +
    "write. No greetings, no headings, no sign-off, plain text only.";
  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: `Category: ${category}\nNotes: ${notes}` },
  ]);
  if (llm) {
    const { sanitizeAiText } = await import("./text");
    return sanitizeAiText(llm);
  }

  // Fallback: lightly structure the raw notes.
  const n = notes.trim();
  return `[${category}] ${n}${/[.!?]$/.test(n) ? "" : "."} Expected the app to behave correctly; please investigate.`;
}

/** Final spec-verification message the agent sends before locking a booking. */
export function verificationMessage(rfq: StructuredRFQ): string {
  const checks = [
    `${vehicleTerm(rfq.vehicleClass)}${rfq.engineSizeCc ? ` (${rfq.engineSizeCc}cc)` : ""}`,
    rfq.transmission !== "any" ? rfq.transmission : null,
    rfq.maxMileageKm ? `under ${rfq.maxMileageKm.toLocaleString()} km` : null,
    ...rfq.accessories,
  ].filter(Boolean);
  return (
    "Before we confirm, can you verify the vehicle matches: " +
    checks.join(", ") +
    "? Please confirm availability and the exact model. Thank you!"
  );
}
