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
    " engineSizeCc?: number, transmission: 'automatic'|'manual'|'any', maxMileageKm?: number," +
    " durationDays: number, accessories: string[], fulfillment: 'hotel-delivery'|'in-store'|'any'," +
    " notes?: string, vendorMessage: string }. The vendorMessage must be a polite, " +
    "professional inquiry that clearly identifies the sender as an automated " +
    "procurement assistant acting on behalf of a traveller.";

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
    engineSizeCc: rfq.engineSizeCc,
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
    engineSizeCc: ccMatch ? parseInt(ccMatch[1], 10) : undefined,
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
  const parts: string[] = [];
  parts.push(
    "Hello! I'm WheelDeal's automated procurement assistant messaging on behalf of a traveller."
  );
  const spec: string[] = [`a ${vehicleTerm(rfq.vehicleClass)}`];
  if (rfq.engineSizeCc) spec.push(`${rfq.engineSizeCc}cc`);
  if (rfq.transmission !== "any") spec.push(rfq.transmission);
  if (rfq.maxMileageKm) spec.push(`under ${rfq.maxMileageKm.toLocaleString()} km`);
  parts.push(
    `They'd like ${spec.join(", ")} for ${rfq.durationDays} day(s).`
  );
  if (rfq.accessories.length)
    parts.push(`Requested extras: ${rfq.accessories.join(", ")}.`);
  if (rfq.fulfillment === "hotel-delivery")
    parts.push("Hotel delivery would be ideal.");
  parts.push("Could you share your best available daily rate? Thank you!");
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
// Bargaining, Market-Analyst & Sentiment Agents (negotiation simulator)
// ---------------------------------------------------------------------------

/**
 * Simulate a negotiation round for a vendor. In production the agent would
 * exchange messages via the WhatsApp Cloud API; here we model the vendor's
 * price response as a function of their base rate, rating, the round number,
 * and the learned tactic in play. Returns the resulting offer.
 */
export function negotiateRound(
  vendor: Vendor,
  rfq: StructuredRFQ,
  round: number
): { offer: Offer; tacticId: string; won: boolean } {
  const tactics = getTactics();
  // "Step up" the tactic as rounds progress - later rounds use stronger plays.
  const tactic = tactics[Math.min(round, tactics.length - 1)] ?? tactics[0];

  const marketRate = marketRateFor(vendor, rfq); // Market-Rate Analyst
  const start = vendor.basePricePerDay + (rfq.vehicleClass === "car" ? 6 : 0);

  // Each round shaves a bit more, bounded by the analyst's fair-market floor.
  const winRate = tactic.uses > 0 ? tactic.wins / tactic.uses : 0.4;
  const cutPct = Math.min(0.28, 0.06 + round * 0.05 + winRate * 0.08);
  const pricePerDay = Math.max(
    Math.round(marketRate * 0.92),
    Math.round(start * (1 - cutPct))
  );

  const includesDelivery =
    rfq.fulfillment === "hotel-delivery" &&
    vendor.fulfillment.includes("hotel-delivery") &&
    round >= 1;
  const includesInsurance = round >= 2 && vendor.rating >= 4.2;

  const offer: Offer = {
    pricePerDay,
    listPricePerDay: Math.round(start),
    currency: "USD",
    totalPrice: pricePerDay * rfq.durationDays,
    includesInsurance,
    includesDelivery,
    round,
    verified: false,
    simulated: true,
    message: vendorReply(vendor, pricePerDay, includesDelivery, includesInsurance),
  };

  const discountPct = Math.round(((start - pricePerDay) / start) * 100);
  const won = pricePerDay <= marketRate;
  recordOutcome(tactic.id, won, discountPct);

  return { offer, tacticId: tactic.id, won };
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

function vendorReply(
  vendor: Vendor,
  price: number,
  delivery: boolean,
  insurance: boolean
): string {
  const extras = [
    delivery ? "free hotel delivery included" : null,
    insurance ? "basic insurance included" : null,
  ].filter(Boolean);
  const tail = extras.length ? ` (${extras.join(", ")})` : "";
  return `Best we can do is $${price}/day${tail}. Ready when you are! - ${vendor.name}`;
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
  images: { mime: string; base64: string }[] = []
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
    "vehicle. If anything is unclear, set confidence low and write a short, " +
    "polite clarifyMessage asking the vendor to confirm the exact vehicle and " +
    "daily price.";

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
    "You help a user write a clear, concise product bug/feedback report. Given " +
    "their rough notes and a category, return 2-4 sentences describing the issue, " +
    "steps to reproduce if implied, and expected vs actual behaviour. Plain text only.";
  const llm = await chat([
    { role: "system", content: system },
    { role: "user", content: `Category: ${category}\nNotes: ${notes}` },
  ]);
  if (llm) return llm.trim();

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
