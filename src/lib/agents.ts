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
import { parseDeposit } from "./deposit";

// ---------------------------------------------------------------------------
// Profiler Agent - free text → structured, vendor-ready RFQ
// ---------------------------------------------------------------------------

export async function runProfiler(
  input: string,
  durationDaysHint?: number,
  voiceKey?: string
): Promise<StructuredRFQ> {
  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("profiler");

  // Variety seed: with hundreds of users, identical vendorMessages would look
  // like a bot blast to shops AND to WhatsApp's spam filters. Each request
  // gets a randomly different, natural phrasing style.
  const styles = [
    "start with a casual greeting and get straight to the point",
    "open by mentioning you're staying nearby, keep it warm and brief",
    "lead with the availability question, then the details",
    "sound easy-going and friendly, one light touch of humour is fine",
    "be brief and practical - a traveller typing on the go",
    "start with 'Good morning/afternoon' style politeness, then the request",
  ];
  const styleSeed = styles[Math.floor(Math.random() * styles.length)];

  // Stable persona: THIS user always sounds like the same distinct human.
  let persona = "";
  if (voiceKey) {
    const { voiceProfileFor, voiceDirectives } = await import("./voice");
    persona = ` ${voiceDirectives(voiceProfileFor(voiceKey))}`;
  }

  // Orchestrator opener stage: owner instructions apply to the first message.
  let openerRules = "";
  try {
    const { getOrchestratorConfig, ownerDirectives } = await import("./orchestrator");
    const ocfg = await getOrchestratorConfig();
    openerRules = ownerDirectives(ocfg, "opener");
    if (openerRules) openerRules = ` ${openerRules}`;
  } catch {
    /* opener rules are an enhancement */
  }

  // Tight budget: this call blocks the START of every search. If the AI is
  // slow, the deterministic heuristic (with its own message variety) takes
  // over - a fast search beats a marginally prettier first message.
  const llm = await chat(
    [
      {
        role: "system",
        content:
          system +
          ` VARIETY: for the vendorMessage, ${styleSeed}. Never reuse a stock template - each message must read like a different real person wrote it.` +
          " REGISTER: vendorMessage in SIMPLE everyday English - short words, short sentences; most shops speak English as a second language." +
          openerRules +
          persona,
      },
      { role: "user", content: input },
    ],
    { budgetMs: 9_000 }
  );

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
    // CHEAPEST BY DEFAULT (item #14): when the traveller names no size/model,
    // they want the cheapest option - which is the smallest. Scooters and
    // motorbikes default to 110cc; cars to a regular 4-seat economy car. The
    // agents then ask shops for a CONCRETE vehicle, never a vague "a bike".
    engineSizeCc: rfq.vehicleClass === "car" ? undefined : rfq.engineSizeCc ?? 110,
    seats: rfq.vehicleClass === "car" ? rfq.seats ?? 4 : undefined,
    carType:
      rfq.vehicleClass === "car"
        ? rfq.carType && rfq.carType !== "any"
          ? rfq.carType
          : "economy"
        : undefined,
    transmission: (["automatic", "manual", "any"].includes(rfq.transmission)
      ? rfq.transmission
      : "any") as Transmission,
    maxMileageKm: rfq.maxMileageKm,
    durationDays: clampDuration(rfq.durationDays || durationHint),
    accessories: Array.isArray(rfq.accessories) ? rfq.accessories.slice(0, 8) : [],
    fulfillment: (["hotel-delivery", "in-store", "any"].includes(rfq.fulfillment)
      ? rfq.fulfillment
      : "any") as Fulfillment,
    notes: rfq.notes,
    ...rentalFields(rfq, input),
    vendorMessage: rfq.vendorMessage || buildMessage({ ...rfq, ...rentalFields(rfq, input) }, input),
  };
}

// A rental duration must be sane - it directly multiplies into totalPrice.
// 0 / negative / NaN / absurd values were passing straight through and
// producing garbage totals. Clamp to 1..90 days.
function clampDuration(n: number | undefined): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 3;
  return Math.min(v, 90);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sanitized real-world rental fields, merged from the LLM parse + free text. */
function rentalFields(rfq: Partial<StructuredRFQ>, input: string): {
  startDate?: string;
  returnDate?: string;
  driverAge?: number;
  license?: { motorbike?: boolean; idp?: boolean };
  insuranceTier?: StructuredRFQ["insuranceTier"];
  oneWayDropOff?: string;
  helmetCount?: number;
} {
  const t = (input || "").toLowerCase();
  const startDate = rfq.startDate && ISO_DATE.test(rfq.startDate) ? rfq.startDate : undefined;
  const returnDate = rfq.returnDate && ISO_DATE.test(rfq.returnDate) ? rfq.returnDate : undefined;
  const ageM = t.match(/\b(1[6-9]|[2-9]\d)\s*(?:years?|yrs?|yo|y\/o)\b/);
  const driverAge =
    typeof rfq.driverAge === "number" && rfq.driverAge >= 16 && rfq.driverAge <= 99
      ? Math.floor(rfq.driverAge)
      : ageM
      ? parseInt(ageM[1], 10)
      : undefined;
  const idp = rfq.license?.idp ?? /\b(idp|international (driving )?(permit|licen[cs]e))\b/.test(t) ? true : undefined;
  const motorbike =
    rfq.license?.motorbike ?? /\bmotor(bike|cycle) licen[cs]e\b/.test(t) ? true : undefined;
  const license = idp || motorbike ? { ...(idp ? { idp: true } : {}), ...(motorbike ? { motorbike: true } : {}) } : undefined;
  const insuranceTier = (["none", "basic", "full", "any"] as const).includes(
    rfq.insuranceTier as never
  )
    ? rfq.insuranceTier
    : /\bfull (insurance|cover)/.test(t)
    ? "full"
    : /\b(no|without) insurance/.test(t)
    ? "none"
    : undefined;
  const helmetM = t.match(/(\d)\s*helmets?/);
  const helmetCount =
    typeof rfq.helmetCount === "number" && rfq.helmetCount > 0 && rfq.helmetCount <= 4
      ? Math.floor(rfq.helmetCount)
      : helmetM
      ? Math.min(parseInt(helmetM[1], 10), 4)
      : undefined;
  const oneWayDropOff =
    typeof rfq.oneWayDropOff === "string" && rfq.oneWayDropOff.trim()
      ? rfq.oneWayDropOff.trim().slice(0, 80)
      : undefined;
  return {
    ...(startDate ? { startDate } : {}),
    ...(returnDate ? { returnDate } : {}),
    ...(driverAge ? { driverAge } : {}),
    ...(license ? { license } : {}),
    ...(insuranceTier ? { insuranceTier } : {}),
    ...(oneWayDropOff ? { oneWayDropOff } : {}),
    ...(helmetCount ? { helmetCount } : {}),
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
    durationDays = clampDuration(/week/.test(daysMatch[2]) ? n * 7 : n);
  }
  durationDays = clampDuration(durationDays);

  const rfq: StructuredRFQ = {
    vehicleClass,
    // Cheapest by default (item #14): no size named = smallest 110cc; no car
    // spec named = regular 4-seat economy.
    engineSizeCc:
      vehicleClass === "car" ? undefined : ccMatch ? parseInt(ccMatch[1], 10) : 110,
    seats: vehicleClass === "car" ? seats ?? 4 : undefined,
    carType: vehicleClass === "car" ? (carType !== "any" ? carType : "economy") : undefined,
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
    ...rentalFields({}, input),
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

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * A freshly-varied first message for ONE shop. Called PER SHOP server-side so
 * that even within a single search, no two shops receive the same opening text
 * (the client's single rfq.vendorMessage was being reused for every shop - the
 * "all shops got the same message" bug). Hundreds of natural combinations.
 */
export function variedFirstMessage(rfq: StructuredRFQ): string {
  return buildMessage(rfq, "");
}

function buildMessage(rfq: StructuredRFQ, raw: string): string {
  // Authentic first-person message from the traveller. VARIETY MATTERS: with
  // hundreds of users, identical first messages look like a bot blast (to the
  // shops AND to WhatsApp's spam filters), so every slot is randomized - the
  // same request produces many natural phrasings.
  const spec: string[] = [];
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
  const vehicle = `${vehicleTerm(rfq.vehicleClass)}${spec.length ? ` (${spec.join(", ")})` : ""}`;
  const days = `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  // WHEN the rental starts is what makes an availability quote real. Include it
  // whenever the request captured a date, phrased naturally.
  const when = rfq.startDate ? prettyDate(rfq.startDate) : "";

  const opener = when
    ? pick([
        `Hi! I'm staying in the area and looking to rent a ${vehicle} for ${days} from ${when}.`,
        `Hello! Do you have a ${vehicle} available for ${days} starting ${when}?`,
        `Hey there! I need a ${vehicle} for ${days} from ${when} - is one free?`,
        `Hi, could I rent a ${vehicle} from you for ${days} starting ${when}?`,
      ])
    : pick([
        `Hi! I'm staying in the area and looking to rent a ${vehicle} for ${days}.`,
        `Hello! Do you have a ${vehicle} available for ${days}?`,
        `Hey there! I'm nearby and need a ${vehicle} for about ${days}.`,
        `Hi, quick question - could I rent a ${vehicle} from you for ${days}?`,
        `Good day! I'm in town for a bit and after a ${vehicle} for ${days}.`,
        `Hey! Looking to rent a ${vehicle} for ${days} - do you have one free?`,
      ]);
  const dropOff = rfq.oneWayDropOff
    ? ` I'd need to drop it off in ${rfq.oneWayDropOff} (one-way).`
    : "";
  const extras =
    rfq.accessories.length > 0
      ? pick([
          `I'd also need: ${rfq.accessories.join(", ")}.`,
          `Would you have ${rfq.accessories.join(" and ")} too?`,
          `Plus ${rfq.accessories.join(", ")} if possible.`,
        ])
      : "";
  const delivery =
    rfq.fulfillment === "hotel-delivery"
      ? pick([
          "Delivery to my hotel would be ideal.",
          "Could you bring it to my hotel?",
          "If you deliver to hotels, even better.",
        ])
      : "";
  const ask = pick([
    "What's your best daily price?",
    "What would the daily rate be?",
    "How much per day, best price?",
    "What's the best you could do per day?",
  ]);
  const thanks = pick(["Thanks!", "Thank you!", "Cheers!", "Thanks a lot!"]);

  return [opener + dropOff, extras, delivery, `${ask} ${thanks}`].filter(Boolean).join(" ");
}

/** Human-friendly date for messages: "Jan 20" (no year noise for near dates). */
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("safety");

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
// Global country -> local currency map so the agent ALWAYS bargains in the money
// the shop uses, anywhere on earth. Matched against the geocoded region string
// (which usually ends in the country name). Order matters only for overlaps.
const REGION_CURRENCY: [RegExp, string][] = [
  [/\bthai|\bthailand\b/i, "THB"],
  [/\bisrael\b|\bpalestin/i, "ILS"],
  [/\bindonesia|\bbali\b|\blombok|\bjakarta/i, "IDR"],
  [/\bvietnam\b|\bviet nam/i, "VND"],
  [/\bindia\b|\bgoa\b/i, "INR"],
  [/\bjapan\b|\bnippon/i, "JPY"],
  [/\bphilippin/i, "PHP"],
  [/\bmalaysia\b|\bkuala lumpur|\blangkawi/i, "MYR"],
  [/\bsingapore\b/i, "SGD"],
  [/\bturkey|\btürkiye|\bturkiye/i, "TRY"],
  [/\bmexico\b|\bméxico|\bcancun|\btulum/i, "MXN"],
  [/\bbrazil|\bbrasil/i, "BRL"],
  [/\bargentin/i, "ARS"],
  [/\bcolombia\b/i, "COP"],
  [/\bperu\b|\bperú/i, "PEN"],
  [/\bchile\b/i, "CLP"],
  [/\bunited arab emirates|\bdubai\b|\babu dhabi|\buae\b/i, "AED"],
  [/\bsaudi\b/i, "SAR"],
  [/\bqatar\b/i, "QAR"],
  [/\bmorocco|\bmarrakech/i, "MAD"],
  [/\begypt\b|\bcairo\b/i, "EGP"],
  [/\bsouth africa|\bcape town|\bjohannesburg/i, "ZAR"],
  [/\bkenya\b/i, "KES"],
  [/\bsri lanka|\bcolombo\b/i, "LKR"],
  [/\bnepal\b/i, "NPR"],
  [/\bcambodia|\bsiem reap|\bphnom penh/i, "USD"], // KHR quoted, USD common
  [/\blaos\b|\blao pdr/i, "LAK"],
  [/\bchina\b|\bbeijing|\bshanghai/i, "CNY"],
  [/\bhong kong/i, "HKD"],
  [/\btaiwan\b|\btaipei/i, "TWD"],
  [/\bsouth korea|\bkorea\b|\bseoul\b/i, "KRW"],
  [/\baustralia|\bsydney|\bmelbourne/i, "AUD"],
  [/\bnew zealand\b/i, "NZD"],
  [/\bcanada\b|\btoronto|\bvancouver/i, "CAD"],
  [/\bswitzerland|\bschweiz|\bsuisse/i, "CHF"],
  [/\bunited kingdom|\bengland|\bscotland|\bwales|\blondon\b/i, "GBP"],
  [/\bpoland\b|\bpolska/i, "PLN"],
  [/\bczech\b|\bprague/i, "CZK"],
  [/\bhungary|\bbudapest/i, "HUF"],
  [/\bsweden\b/i, "SEK"],
  [/\bnorway\b/i, "NOK"],
  [/\bdenmark\b/i, "DKK"],
  [/\brussia\b|\bmoscow/i, "RUB"],
  [
    /\beuro\b|\bspain|\bitaly|\bfrance|\bgermany|\bportugal|\bgreece|\bnetherlands|\bireland|\baustria|\bbelgium|\bcroatia|\bcyprus|\bmalta|\bfinland|\bslovak|\bsloven|\bestonia|\blatvia|\blithuania/i,
    "EUR",
  ],
  [/\bunited states|\busa\b|\bu\.s\.|\bamerica\b/i, "USD"],
];

/** Best-guess local currency for a geocoded region string (undefined if unknown). */
export function currencyForRegion(region?: string): string | undefined {
  if (!region) return undefined;
  for (const [re, cur] of REGION_CURRENCY) if (re.test(region)) return cur;
  return undefined;
}

// Symbols for currencies the agent quotes in. Anything not listed prints the
// ISO code after the number (e.g. "1200 CZK") - always correct, never wrong.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", THB: "฿", ILS: "₪", JPY: "¥", INR: "₹",
  IDR: "Rp", VND: "₫", PHP: "₱", MYR: "RM", SGD: "S$", AUD: "A$", NZD: "NZ$",
  CAD: "C$", CHF: "CHF", CNY: "¥", HKD: "HK$", TWD: "NT$", KRW: "₩", TRY: "₺",
  MXN: "$", BRL: "R$", ARS: "$", COP: "$", CLP: "$", PEN: "S/", AED: "د.إ",
  SAR: "﷼", QAR: "﷼", MAD: "DH", EGP: "E£", ZAR: "R", KES: "KSh", LKR: "Rs",
  NPR: "Rs", LAK: "₭", PLN: "zł", CZK: "Kč", HUF: "Ft", SEK: "kr", NOK: "kr",
  DKK: "kr", RUB: "₽",
};

/** Format money in the LOCAL rental currency (never force dollars). */
export function money(amount: number, currency?: string): string {
  const c = (currency || "USD").toUpperCase();
  const n = Math.round(amount).toLocaleString();
  const sym = CURRENCY_SYMBOLS[c];
  if (!sym) return `${n} ${c}`;
  return sym.length > 1 ? `${sym} ${n}` : `${sym}${n}`;
}

/**
 * Rewrite an outbound message NATIVELY in the main local language of the
 * region (Ultra local-language mode). Returns the original text untouched if
 * the AI is unavailable or the region is unknown - never blocks a send.
 * The English gloss is kept so the traveller can read what was sent.
 */
export async function localizeMessage(
  message: string,
  region?: string,
  voiceKey?: string,
  street = true
): Promise<{ text: string; english?: string; localized: boolean }> {
  void voiceKey; // persona intentionally not applied to local-language output
  if (!region) return { text: message, localized: false };
  // NB: we deliberately do NOT inject the English voice persona here - its
  // literal greeting ("Hey") was leaking into the local-language output. The
  // local register itself carries the human tone.
  //
  // DETERMINISM: one transient LLM hiccup must not flip a single shop in the
  // hunt to English while its neighbours get the local language - so a failed
  // attempt retries once before the (documented) English fallback applies.
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await chat(
      [
        {
          role: "system",
          content:
            `Rewrite the traveller's WhatsApp message ENTIRELY in the everyday local language of ${region}, ` +
            "the casual friendly way a local customer messages a rental shop. " +
            (street
              ? "REGISTER: street-level everyday spoken language - short sentences, the words " +
                "people actually type in chats. NEVER formal or written-speech register. "
              : "") +
            "CRITICAL RULES:\n" +
            "1. Translate the WHOLE message including the greeting and sign-off. Do NOT leave ANY English " +
            "words (no 'Hey', 'Hi', 'Thanks', etc.) - use a natural LOCAL greeting instead.\n" +
            "2. Keep every fact exactly (vehicle, cc, days, accessories, prices); numbers stay as given.\n" +
            "3. The \"english\" field MUST be a FAITHFUL, COMPLETE English translation of the local-language " +
            "message you wrote - the SAME meaning and detail, sentence for sentence, NOT a shortened summary. " +
            "The traveller reads it to know EXACTLY what was sent on their behalf.\n" +
            'Reply ONLY as JSON: { "message": "<full local-language text>", "english": "<faithful full English translation of that exact text>" }.',
        },
        { role: "user", content: message },
      ],
      { budgetMs: 9_000 }
    );
    if (out) {
      const parsed = extractJson<{ message?: string; english?: string }>(out);
      if (parsed?.message && parsed.message.trim().length > 5) {
        const { sanitizeAiText } = await import("./text");
        return {
          text: sanitizeAiText(parsed.message),
          // The gloss is the faithful translation of what we actually sent; if
          // the model omitted it, fall back to the original English source.
          english: parsed.english ? sanitizeAiText(parsed.english) : message,
          localized: true,
        };
      }
    }
  }
  // Honest, DOCUMENTED fallback: English beats a failed send. Callers log a
  // localize-fallback event so a language flip is never a silent mystery.
  return { text: message, localized: false };
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
  // Identity of the human whose WhatsApp sends this - powers the stable
  // per-user voice persona and the anti-repetition memory.
  voiceKey?: string;
  // Orchestrator additions: owner stage instructions, edge rules, language
  // register and strategist leverage notes, appended to the system prompt.
  extraDirectives?: string;
}): Promise<{
  message: string;
  tacticId: string;
  tacticLabel: string;
  english?: string;
  // True when the AI was unreachable and a varied template was used instead.
  fallback?: boolean;
}> {
  const cur = opts.currency || currencyForRegion(opts.region) || "USD";
  // Sane target: the market floor when we know it, otherwise a modest 15% cut.
  // The REAL floor is the honest lower bound - when we know it we may ask it
  // outright (the playbook's first push IS the floor); only without a floor
  // does the 60%-of-quote guard protect against absurd lowballs.
  const quoted = opts.currentPricePerDay;
  let target = opts.targetPricePerDay;
  if (!target && quoted) {
    target = Math.round(quoted * 0.85);
  }
  if (target && quoted) {
    const lowest = opts.floorPricePerDay ?? Math.round(quoted * 0.6);
    if (target < lowest) target = lowest;
    // Ask for a clean, human number (220, not 213) - odd figures read as
    // robotic and weaken the ask. When the ENGINE provided the target it is
    // already nice-rounded and recorded in thread state (lastTarget) - do not
    // re-round it here or the message would name a different number than the
    // ladder tracks.
    if (!opts.targetPricePerDay) target = roundNice(target);
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

  const spec =
    opts.rfq.vehicleClass === "car"
      ? `${[
          opts.rfq.transmission !== "any" ? opts.rfq.transmission : "",
          opts.rfq.carType && opts.rfq.carType !== "any" ? opts.rfq.carType : "",
          "car",
          opts.rfq.seats ? `${opts.rfq.seats} seats` : "",
        ]
          .filter(Boolean)
          .join(" ")} for ${opts.rfq.durationDays} day(s)`
      : `${opts.rfq.engineSizeCc ? opts.rfq.engineSizeCc + "cc " : ""}${vehicleTerm(
          opts.rfq.vehicleClass
        )} for ${opts.rfq.durationDays} day(s)`;

  // Duration-based discount levers: long rentals deserve the weekly/monthly
  // rate framing - the strongest honest card a traveller holds.
  const rentalDays = opts.rfq.durationDays;
  const durationLever =
    rentalDays >= 25
      ? `The rental is ${rentalDays} days - essentially a MONTH. Frame the ask around the monthly rate ("for one month, what is your monthly price?") - monthly rates are always far below day-rate x days. `
      : rentalDays >= 7
      ? `The rental is ${rentalDays} days - a week or more. Frame the ask around the weekly rate ("for ${rentalDays} days, can you give the weekly price?") - shops always have a lower weekly number. `
      : "";
  // When the shop resists the number, value can still be won at THEIR price.
  const packagePivot =
    `If they push back on the number, pivot to PACKAGE value at their price instead of arguing: ` +
    `free helmet(s), free delivery to the hotel, a full tank, or free insurance - pick ONE that fits the chat. `;

  // Round-aware playbook directives - the owner's launch scripts, generalized.
  const roundPlay =
    (opts.round <= 0
      ? `FIRST PUSH (the owner's playbook): their opening quote is above the fair local price. ` +
        `Use the rental DAYS as leverage: warmly apologize that the quote is really expensive for you, ` +
        `mention you are renting for ${opts.rfq.durationDays} days (a long time), and ask for the target ` +
        `price per day like a friend would. The SHAPE to follow (NEVER these exact words - always fresh phrasing): ` +
        `"oh so sorry, <their price> is really expensive for me. I rent for <days> days, long time. ` +
        `Can you give me <target> a day my friend? <one warm emoji>". `
      : opts.round === 1
      ? `SECOND PUSH: they refused the first ask ("cannot give that price"). Come back relaxed and friendly ` +
        `with the new, slightly higher round-number target - meet them partway, make it feel easy to say yes, ` +
        `hint you are ready to book today. Never apologize twice, never sound needy. ` +
        packagePivot
      : `FINAL NUDGE: one last tiny, warm ask at the target - fully relaxed, zero pressure, ` +
        `and make clear you are happy either way. ` +
        packagePivot) + durationLever;

  const system =
    "You write ONE short WhatsApp message from a real human traveller chatting " +
    "with a rental shop. Rules: plain text only, no markdown, no asterisks, no " +
    "emoji spam (max one), 1-3 sentences, warm and polite, never robotic, never " +
    "mention an app or assistant. Never invent prices we were not given. " +
    roundPlay +
    "Never repeat a question the shop already answered. " +
    "VARY YOUR ARGUMENTS: never reuse a lever already played in this " +
    "conversation (check the history) - if the many-days card was used, switch " +
    "to the weekly rate, a package ask (helmet/delivery/full tank), the rival " +
    "offer, or booking right now. A repeated argument reads as a bot. " +
    (opts.history
      ? "Conversation so far (oldest first) - do NOT re-ask anything answered here:\n" +
        opts.history +
        "\n"
      : "") +
    `Preferred tactic: "${tactic.label}" (${tactic.script}). ` +
    (target
      ? `THE ASK: ask if ${money(target, cur)}/day is possible for the ${opts.rfq.durationDays}-day rental - this number is anchored to the real local market floor. NEVER propose a number lower than ${money(opts.floorPricePerDay ?? Math.round((quoted ?? target) * 0.6), cur)} - unrealistic lowballs insult the shop. `
      : "Do NOT propose any specific number - just warmly ask for their best price. ") +
    `CRITICAL MONEY RULE: talk about price ONLY in ${cur} - the shop's own local currency. Never write a dollar sign or convert to USD unless ${cur} is USD. Match the numbers the shop uses. ` +
    (opts.localLanguage && opts.region
      ? `CRITICAL: think and write NATIVELY in the main local language of ${opts.region} from the first word - never compose in English and translate. Use the casual street register a savvy local uses at the market: local haggling phrases, local currency habits, natural slang (respectful, never rude). Short and punchy. `
      : `Write in SIMPLE, warm, everyday English - the way a friendly traveller actually types on WhatsApp. Use short sentences and common words a non-native speaker easily understands. Contractions are good. NO fancy or formal vocabulary, NO clever idioms or wordplay, NO business/salesy tone. Most rental shops here speak English as a second language, so keep it plain, kind and easy to read. ` +
        (opts.region
          ? `The shop is in ${opts.region}; keep every sentence short and very simple. `
          : "")) +
    (training
      ? "Learn tone and moves from these REAL past bargains by the owner:\n" + training
      : "");

  // Owner-editable house rules for the bargaining agent (never removable).
  const { getPrompt } = await import("./prompts");
  const directives = await getPrompt("bargain_directives");
  let systemWithDirectives = directives ? `${system}\nHOUSE RULES: ${directives}` : system;
  // Orchestrator: owner stage instructions, edge rules, register, leverage.
  if (opts.extraDirectives?.trim()) {
    systemWithDirectives += `\n${opts.extraDirectives.trim()}`;
  }
  // Mid-conversation bargains never greet again - we are already talking.
  if (opts.history) {
    systemWithDirectives +=
      "\nYou are MID-CONVERSATION: do NOT start with a greeting (no hey/hi/hello) - go straight into the message.";
  }

  // ZERO-PATTERN AUTHENTICITY: (a) a stable per-user voice persona so every
  // user's agent sounds like ONE consistent, distinct human; (b) the user's
  // recent outbound messages injected as a DO-NOT-REPEAT list so no phrasing
  // is ever recycled across shops.
  if (opts.voiceKey) {
    const { voiceProfileFor, voiceDirectives } = await import("./voice");
    systemWithDirectives += `\n${voiceDirectives(voiceProfileFor(opts.voiceKey))}`;
    try {
      const recent = await sbSelect<{ body: string | null }>(
        "whatsapp_messages",
        `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          opts.voiceKey
        )}&order=received_at.desc&limit=5`
      );
      const lines = recent.map((r) => (r.body ?? "").slice(0, 160)).filter(Boolean);
      if (lines.length) {
        systemWithDirectives +=
          "\nANTI-REPETITION (critical): these are messages this person sent recently. " +
          "Your new message must NOT reuse their openings, sentence structures or phrasings - " +
          "write something genuinely fresh:\n- " +
          lines.join("\n- ");
      }
    } catch {
      /* anti-repeat context is an enhancement */
    }
  }

  const user =
    `Vehicle: ${spec}. Currency: ${cur}. ` +
    (quoted ? `They quoted ${money(quoted, cur)}/day. ` : "No quote yet. ") +
    (opts.rivalPricePerDay
      ? `LEVERAGE: another shop already offered this traveller ${money(
          opts.rivalPricePerDay,
          cur
        )}/day for the same vehicle. Naturally mention you already have an offer at ${money(
          opts.rivalPricePerDay,
          cur
        )}/day and warmly ask if THIS shop can beat it - make clear that if they go lower you'll rent from them. Friendly, never threatening. `
      : "") +
    (target
      ? `Write our single friendly ask for ${money(target, cur)}/day. All amounts in ${cur}.`
      : `Write one friendly message asking their best price. All amounts in ${cur}.`);

  // When bargaining in the LOCAL language, ask for BOTH the local message and
  // a short plain-English gloss (as JSON) so the traveller can read what their
  // agent is saying on their behalf.
  const localSystem = opts.localLanguage
    ? systemWithDirectives +
      ' Reply ONLY as JSON: { "message": "<the local-language message>", "english": "<a short plain-English translation of it>" }.'
    : systemWithDirectives;

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

  // Deterministic fallback (AI unreachable). Varied templates so even the
  // fallback never sends the same message twice, and it is flagged so the UI
  // can tell the user this was a template, not the real agent brain.
  const t = target ? money(target, cur) : undefined;
  const rival = opts.rivalPricePerDay ? money(opts.rivalPricePerDay, cur) : undefined;
  const days = opts.rfq.durationDays;
  const vt = vehicleTerm(opts.rfq.vehicleClass);
  const q = quoted ? money(quoted, cur) : undefined;
  const fallbackPool = rival
    ? [
        `Thanks! Just being upfront - another shop offered me ${rival}/day for the same ${vt}. If you can beat that, I'll happily rent from you. Could you do ${t ?? rival}/day for the ${days} days?`,
        `Appreciate it! I do have an offer at ${rival}/day for a similar ${vt}. I'd honestly prefer your place - any chance you could do ${t ?? rival}/day for ${days} days?`,
      ]
    : t && opts.round <= 0
    ? [
        // The owner's opener: days as leverage, ask the floor, warm as a friend.
        `Oh sorry${q ? `, ${q}` : ""} is really expensive for me 🫶 I'm renting ${days} days, long time - could you do ${t} a day my friend?`,
        `Ah that's a bit much for me honestly! Since I take it for ${days} days, can you make it ${t}/day? Would book right away 🙏`,
        `Ouch${q ? `, ${q}/day` : ""} is over my budget 😅 For ${days} days straight, would ${t} a day work? I'd confirm today.`,
      ]
    : t
    ? [
        `Okay I understand! Let's meet in the middle - ${t}/day for the ${days} days and I book now? 🙂`,
        `Fair enough! Could we say ${t}/day since it's ${days} full days? If yes I'm in.`,
        `Got it - what about ${t}/day for the ${days} days? That would seal it for me today 🤝`,
      ]
    : [
        `Thanks! What's the very best daily rate you could do for the ${days} days? I'm ready to book if it works.`,
        `Appreciate it! Any wiggle room on the daily price for a ${days}-day rental? I can confirm right away.`,
      ];
  const filled = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
  return {
    message: sanitizeAiText(filled),
    tacticId: tactic.id,
    tacticLabel: tactic.label,
    fallback: true,
  };
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
  // ONLY set when the shop explicitly confirmed them - never guessed.
  deposit?: string; // e.g. "Passport only", "3,000 THB cash"
  // Structured deposit derived from the label (see lib/deposit.ts).
  depositType?: import("./deposit").DepositType;
  depositAmount?: number;
  depositCurrency?: string;
  // What KIND of image the shop sent (set by the vision classifier). Lets the
  // branching engine thank the shop for a vehicle photo vs read a price sheet.
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
  delivers?: boolean | null;
  // Extra rental terms, only when the shop explicitly stated them.
  deliveryFee?: number | null; // in the reply's currency; 0 = free
  insuranceIncluded?: boolean | null;
  kmLimitPerDay?: number | "unlimited" | null;
  fuelPolicy?: string | null;
  // ---- Negotiation-state signals for the graph engine (never guessed) -------
  // The shop offered to COME PICK THE TRAVELLER UP (by car/bike) - distinct
  // from delivering the vehicle to the hotel.
  pickupOffered?: boolean | null;
  // The shop explicitly said in-store only ("come to shop", "no delivery").
  onShopOnly?: boolean | null;
  // The shop is holding firm on price ("last price", "cannot go lower").
  shopFirm?: boolean | null;
  // The shop WALKED AWAY: told the traveller to take the other offer, said
  // not interested / no thanks / goodbye. Ends the negotiation gracefully.
  shopDeclined?: boolean | null;
  // The shop's tone in THIS reply - "annoyed" stops further pushing.
  shopTone?: "warm" | "neutral" | "annoyed" | null;
  // Constrained fact tags (item #13) from the reply, e.g. "helmets-included".
  // Vocabulary is enforced in vendor-tags.ts; anything else is dropped.
  tags?: string[];
  // ---- Extract-everything media fields (photos carry facts nobody asked yet) --
  // Odometer reading in km when visible in a photo (never confused with price).
  mileageKm?: number | null;
  // Honest visible-condition note (scratches, worn tires, clean/new...).
  conditionNotes?: string | null;
  // 1-3 sentences listing EVERYTHING informative seen in the photo.
  imageSummary?: string | null;
}

// Deterministic negotiation-signal readers - the no-LLM fallback AND the
// arithmetic backstop that always runs (a model can miss "last price"; the
// regex never does). Word boundaries keep "no discount" from matching inside
// unrelated text.
const FIRM_RX =
  /\b(last price|final price|best price already|fix(?:ed)? price|cannot (?:go )?lower|can'?t (?:go )?lower|no discount|no lower|lowest (?:price|already)|same price for everyone|price is firm)\b/i;
const PICKUP_RX =
  /\b(pick you up|come pick you|we pick you|i pick you|pick[- ]?up service|we (?:can )?come (?:get|take) you)\b/i;
const ON_SHOP_RX =
  /\b(only (?:at|in) (?:the )?shop|come (?:to|at) (?:the )?shop|no delivery|pick ?up at (?:the )?shop|you come (?:to )?(?:the )?shop|at shop only|in[- ]store only)\b/i;
const ANNOYED_RX =
  /\b(go (?:to )?(them|others?)( then)?|stop asking|already told you|how many times|waste (?:my|our) time|no more|enough|final answer)\b/i;
// The shop walks away from the deal ("that's OK you can take it there",
// "not interested", "no thanks", "good luck") - the negotiation is over.
const DECLINED_RX =
  /\b(you can take it there|take (?:it|that) (?:one|offer|deal)( then)?|go with (?:them|the other)|not interested|no,? thank(?:s| you)[.! ]*$|good luck( then)?|we (?:can'?t|cannot) help|sorry,? (?:no|cannot))\b/i;

export function readNegotiationSignals(text: string): {
  pickupOffered: boolean | null;
  onShopOnly: boolean | null;
  shopFirm: boolean | null;
  shopDeclined: boolean | null;
  shopTone: "warm" | "neutral" | "annoyed" | null;
} {
  const t = text || "";
  return {
    pickupOffered: PICKUP_RX.test(t) ? true : null,
    onShopOnly: ON_SHOP_RX.test(t) ? true : null,
    shopFirm: FIRM_RX.test(t) ? true : null,
    shopDeclined: DECLINED_RX.test(t) ? true : null,
    shopTone: ANNOYED_RX.test(t) ? "annoyed" : null,
  };
}

/**
 * Deterministic deposit reader - the no-LLM backstop. Only fires when the
 * message actually talks about a deposit/passport/cash-guarantee (never turns
 * a daily price into a deposit), then reuses the same parseDeposit the LLM
 * path uses so "Passport only" / "Deposit 3000 cash" / "3000 cash is fine"
 * register even when every AI provider is down.
 */
export function heuristicDepositFields(
  text: string,
  fallbackCurrency?: string
): Pick<ExtractedOffer, "deposit" | "depositType" | "depositAmount" | "depositCurrency"> {
  const t = (text || "").trim();
  if (!t || !/(deposit|passport|id card|licen[cs]e|\bcash\b)/i.test(t)) return {};
  // Work sentence-by-sentence so we grab the deposit clause, not the price.
  const sentence = t
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .find((s) => {
      if (!/(deposit|passport|id card|licen[cs]e|\bcash\b)/i.test(s)) return false;
      // "200 per day cash" is a PRICE clause - only accept a cash-only clause
      // when it cannot be the daily rate.
      if (/per\s*day|\/\s*day|a day|daily/i.test(s) && !/deposit|passport/i.test(s)) return false;
      return true;
    });
  if (!sentence) return {};
  const parsed = parseDeposit(sentence, fallbackCurrency);
  if (!parsed || parsed.type === "other") return {};
  return {
    deposit: sentence.slice(0, 80),
    depositType: parsed.type,
    depositAmount: parsed.amount,
    depositCurrency: parsed.currency,
  };
}

export async function extractOffer(
  rfq: StructuredRFQ,
  text: string,
  images: { mime: string; base64: string }[] = [],
  history?: string,
  region?: string
): Promise<ExtractedOffer> {
  const { chatVision } = await import("./ai");
  // Full spec INCLUDING car details - "car" alone can never be verified
  // against "automatic 5-seat SUV", so extraction was blind for car rentals.
  const spec =
    rfq.vehicleClass === "car"
      ? [
          rfq.transmission !== "any" ? rfq.transmission : "",
          rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
          "car",
          rfq.seats ? `${rfq.seats} seats` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : `${rfq.engineSizeCc ? rfq.engineSizeCc + "cc " : ""}${
          rfq.vehicleClass === "scooter" ? "automatic scooter" : "manual motorcycle"
        }${rfq.maxMileageKm ? `, under ${rfq.maxMileageKm} km` : ""}`;

  // The local currency of the shop. When a shop replies with a bare number and
  // no symbol ("250 per day"), it means 250 in THEIR money - never dollars.
  const localCur = currencyForRegion(region);
  // Did the reply contain ANY explicit currency token? Word boundaries matter:
  // "aud" must not match inside "audience", "rm" not inside "room".
  const symbolMatch = text.match(
    /\$|€|฿|₱|₹|₫|\b(?:usd|idr|rp|eur|thb|aud|nzd|myr|rm|php|inr|vnd)\b/i
  );

  const system =
    "You extract rental price offers from a vendor's reply (text and/or a photo " +
    "of a price list). The traveller asked for: " +
    spec +
    ". Reply ONLY as JSON: { \"found\": boolean, \"pricePerDay\": number, " +
    '"currency": string, "vehicleDescription": string, "matchesSpec": boolean, ' +
    '"confidence": "high"|"medium"|"low", "clarifyMessage": string, ' +
    '"deposit": string, "delivers": boolean|null, "deliveryFee": number|null, ' +
    '"insuranceIncluded": boolean|null, "kmLimitPerDay": number|"unlimited"|null, ' +
    '"fuelPolicy": string|null, "imageKind": "vehicle"|"price_sheet"|"document"|"other"|null, ' +
    '"pickupOffered": boolean|null, "onShopOnly": boolean|null, ' +
    '"shopFirm": boolean|null, "shopDeclined": boolean|null, ' +
    '"shopTone": "warm"|"neutral"|"annoyed"|null, ' +
    '"mileageKm": number|null, "conditionNotes": string|null, "imageSummary": string|null, ' +
    '"tags": string[] }. ' +
    "pickupOffered: true ONLY if the shop offered to come pick the TRAVELLER up " +
    "(by car or motorbike) and bring them to the shop - this is different from " +
    "delivering the vehicle; null when not mentioned. " +
    "onShopOnly: true only if the shop clearly said in-store only / come to the " +
    "shop / no delivery; null otherwise. " +
    "CRITICAL for the signals pickupOffered/onShopOnly/shopFirm/shopTone: they " +
    "describe ONLY the NEWEST reply above, NEVER earlier messages in the " +
    "history. shopFirm: true only if THIS reply refuses to lower a price it " +
    "already gave ('last price', 'cannot lower', 'fixed price'); a firm-sounding " +
    "line with NO price quoted yet is null, and a reply that LOWERS the price " +
    "is never firm. " +
    "shopTone: how the shop sounds in THIS reply - 'annoyed' if irritated or " +
    "telling us to stop asking, 'warm' if friendly, else 'neutral'. " +
    "shopDeclined: true ONLY if THIS reply walks away from the deal - tells the " +
    "traveller to take the other shop's offer ('that's OK you can take it " +
    "there'), says not interested / no thanks / can't help / goodbye. A refusal " +
    "to LOWER a price is shopFirm, NOT shopDeclined. null when neither. " +
    "imageKind: ONLY when a photo is attached, classify it - \"vehicle\" if it is " +
    "a photo of the actual scooter/motorbike/car, \"price_sheet\" if it shows " +
    "prices/rates/a menu, \"document\" for papers/contracts/IDs, else \"other\"; " +
    "null when there is no image. If the photo is just the VEHICLE (no prices), " +
    "set found=false and do NOT invent a price - we will simply thank the shop. " +
    "EXTRACT EVERYTHING FROM PHOTOS, even facts nobody asked about yet - they " +
    "become leverage or save a question later: mileageKm = the odometer reading " +
    "in km if visible (never a price); conditionNotes = a short honest note on " +
    "visible condition (scratches, dents, worn tires, broken mirror, clean/new " +
    "look, interior state for cars); imageSummary = 1-3 plain sentences listing " +
    "EVERYTHING informative you can see (every model + its price, deposit lines, " +
    "opening hours, phone numbers, shop name, insurance/helmet notes...). All " +
    "three are null when there is no image or nothing visible. " +
    "PRICE-SHEET PHOTOS: rental shops post boards listing MANY models, each with " +
    "its own per-day price (e.g. Honda Click 125cc 300, Yamaha NMAX 155cc 500). " +
    "Pick the model row that MATCHES the traveller's request above (same class " +
    "and closest cc) and return THAT price with found=true, matchesSpec=true and " +
    "the model name in vehicleDescription. " +
    "WHEN SEVERAL ROWS MATCH the requested class and cc, ALWAYS return the " +
    "CHEAPEST matching row - the traveller wants the lowest price that fits, " +
    "NEVER a premium/new-model/bigger-engine row when a cheaper matching row " +
    "exists (e.g. asked: automatic 125cc; sheet has Yamaha Fino 125 at 280, " +
    "Click 125 LED at 300, Click 125 New Model at 350 -> return 280, and name " +
    "the cheaper alternatives in imageSummary). " +
    "TRANSMISSION MATTERS: a 'semi automatic'/'semi-auto' model is NOT an " +
    "automatic scooter - exclude semi-automatic rows when the traveller asked " +
    "automatic (and vice versa); 'automatic'/CVT scooters (Click, Fino, Scoopy, " +
    "Filano, PCX, NMAX...) match an automatic request. " +
    "WEEKLY/MONTHLY COLUMNS: sheets often list both a day rate and a week rate " +
    "('300 Baht/Day, 1,900 Baht/Week'). pricePerDay is the DAY rate of the " +
    "chosen row, but ALWAYS spell out the weekly rate and its per-day value in " +
    "imageSummary (1,900/7 = ~271/day) - for 7+ day rentals it is the honest " +
    "bargaining anchor. " +
    "The sheet may be in ANY language " +
    "(Thai, Hungarian, Indonesian...) - deposit lines like 'Letet: Utlevel vagy " +
    "3000 Baht' mean 'Deposit: passport or 3000 baht', so read deposit tiers per " +
    "model size too. Opening hours on the sheet (e.g. OPEN 08.00AM) are context, " +
    "never a price. An odometer/mileage number (e.g. 45,000 km) is NEVER a price. " +
    "matchesSpec is true ONLY if the price clearly refers to the exact requested " +
    "vehicle. Combine the reply with the conversation history: if the vehicle " +
    "and daily price are both clear from the thread as a whole, set matchesSpec " +
    "true and confidence high. Only when something is genuinely still unknown, " +
    "write a short, polite clarifyMessage - and it must NEVER repeat a question " +
    "the vendor already answered anywhere in the thread. " +
    `THE MOST IMPORTANT ARITHMETIC RULE: the traveller wants ${rfq.durationDays} day(s), ` +
    "and shops OFTEN quote the TOTAL for the whole rental, not per day. " +
    '"3 days 900" or "900 for 3 day" means 900 TOTAL, so pricePerDay is 300 (900/3). ' +
    "pricePerDay MUST be the true PER-DAY price: when the quote covers the whole " +
    "period, DIVIDE by the number of days. Only treat a number as per-day when the " +
    'shop says so ("per day", "/day", "a day") or quotes for 1 day. ' +
    "deposit: ONLY if the shop explicitly stated a deposit requirement, a short " +
    "label like 'Passport only', '3,000 THB cash', 'Passport or 2,000 THB' - " +
    "otherwise an empty string. NEVER guess. " +
    "delivers: true only if they clearly said they deliver / bring the vehicle, " +
    "false only if they clearly said no delivery, null when not mentioned. " +
    "deliveryFee: the delivery charge as a plain number in the same currency " +
    "(0 if they said delivery is free), null if not mentioned. " +
    "insuranceIncluded: true only if they said insurance is included, false if " +
    "they said it costs extra / is not included, null if not mentioned. " +
    "kmLimitPerDay: the daily km/mileage limit as a number, \"unlimited\" if they " +
    "said unlimited, null if not mentioned. fuelPolicy: a short label like " +
    "'full-to-full' or 'same-to-same' only if stated, else null. NEVER guess any of these. " +
    "tags: facts the shop EXPLICITLY stated in this reply, chosen ONLY from: " +
    "delivery, pickup-only, airport-delivery, no-deposit, passport-deposit, " +
    "cash-deposit, helmets-included, insurance-included, cards-accepted, " +
    "flexible-dates. Empty array when nothing applies - NEVER guess or infer. " +
    "clarifyMessage register: SIMPLE everyday English a non-native shop owner " +
    "instantly understands - short words, short sentences, never formal, and " +
    "never a greeting (we are mid-conversation). " +
    (localCur
      ? `IMPORTANT: this shop is in a place whose local currency is ${localCur}. ` +
        `If the reply gives a bare number with no currency symbol, the currency is ` +
        `${localCur} - NEVER assume US dollars. Return currency "${localCur}" in that case.`
      : "If the reply gives a bare number with no symbol, return the shop's local currency, not USD.") +
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
      // "unknown" must never read as "wrong vehicle": matchesSpec=false is the
      // WRONG-vehicle signal and freezes every director move downstream.
      matchesSpec: true,
      confidence: "low",
      clarifyMessage: `Thanks for the photo! Could you confirm in text the daily price for the ${spec}? Just want to be sure we quote the right vehicle.`,
      ...heuristicDepositFields(text, localCur),
      ...readNegotiationSignals(text),
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

  // Heuristic fallback: find a price, but never auto-verify it. A bare number
  // is in the shop's LOCAL currency, never dollars.
  const m =
    text.match(/(?:\$|usd|idr|rp|eur|€|thb|฿|rm|php|₱|₹|₫)?\s?(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)\s*(?:\/|per\s*)?(?:day|d\b)/i) ??
    // "170 last price" / "final price 400" - a firm quote is still a quote.
    text.match(/(\d{2,3}(?:[.,]\d{3})*)\s*(?:is\s*)?(?:my\s*|the\s*)?(?:last|final|best)\s*price/i) ??
    text.match(/(?:last|final|best)\s*price\s*(?:is\s*)?[,:]?\s*(\d{2,3}(?:[.,]\d{3})*)/i);
  // Guard: in "3 day 900" the regex catches the DURATION ("3 day"), not the
  // price - never mistake the day count for a daily rate.
  const heuristicPrice = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
  if (m && heuristicPrice > 0 && heuristicPrice !== rfq.durationDays) {
    return {
      found: true,
      pricePerDay: heuristicPrice,
      currency: symbolMatch ? currencyFromToken(symbolMatch[0]) : localCur || "USD",
      // The regex cannot judge the vehicle, and "unknown" must not read as
      // "wrong vehicle" (false blocks bargain/probe/present entirely - the
      // engine would go 100% mute whenever every LLM provider is down).
      matchesSpec: true,
      confidence: "medium",
      clarifyMessage: `Great, thank you! Just to confirm: is that the daily price for the ${spec} exactly? Once you confirm I'll pass it to the traveller.`,
      ...heuristicDepositFields(text, localCur),
      ...readNegotiationSignals(text),
    };
  }
  return {
    found: false,
    matchesSpec: true,
    confidence: "low",
    clarifyMessage: `Could you share your best daily price for the ${spec}? Thank you!`,
    ...heuristicDepositFields(text, localCur),
    ...readNegotiationSignals(text),
  };

  function normalizeExtraction(e: ExtractedOffer, specStr: string): ExtractedOffer {
    const conf = ["high", "medium", "low"].includes(e.confidence) ? e.confidence : "low";
    const verifiedEnough = e.found && e.matchesSpec && conf === "high";
    // Negotiation signals: the deterministic regex layer ALWAYS backs the model
    // (true from either source wins; the model can add what the regex missed).
    const sig = readNegotiationSignals(text);
    // If the model returned no currency (or defaulted to USD for a bare number
    // in a non-USD country), stamp the real local currency.
    let cur = e.currency;
    const hadSymbol = symbolMatch != null;
    if (localCur && (!cur || (cur.toUpperCase() === "USD" && localCur !== "USD" && !hadSymbol))) {
      cur = localCur;
    }
    // The deterministic deposit reader backs the model here too - a model that
    // skips "Passport only" must not erase a deposit the regex clearly sees.
    const deposit =
      (typeof e.deposit === "string" ? e.deposit.trim().slice(0, 80) : "") ||
      heuristicDepositFields(text, localCur).deposit ||
      "";
    // Derive a structured deposit from the label so the app can show a precise
    // "cash amount / passport" tag next to the price and filter by kind.
    const depositStruct = deposit ? parseDeposit(deposit, cur) : null;
    const km =
      e.kmLimitPerDay === "unlimited"
        ? "unlimited"
        : typeof e.kmLimitPerDay === "number" && e.kmLimitPerDay > 0
        ? Math.round(e.kmLimitPerDay)
        : null;
    return {
      ...e,
      currency: cur,
      confidence: conf,
      deposit: deposit || undefined,
      depositType: depositStruct?.type,
      depositAmount: depositStruct?.amount,
      depositCurrency: depositStruct?.currency,
      imageKind:
        e.imageKind && ["vehicle", "price_sheet", "document", "other"].includes(e.imageKind)
          ? e.imageKind
          : undefined,
      delivers: typeof e.delivers === "boolean" ? e.delivers : null,
      deliveryFee: typeof e.deliveryFee === "number" && e.deliveryFee >= 0 ? e.deliveryFee : null,
      insuranceIncluded: typeof e.insuranceIncluded === "boolean" ? e.insuranceIncluded : null,
      kmLimitPerDay: km,
      fuelPolicy: typeof e.fuelPolicy === "string" && e.fuelPolicy.trim() ? e.fuelPolicy.trim().slice(0, 40) : null,
      pickupOffered: e.pickupOffered === true || sig.pickupOffered === true ? true : null,
      onShopOnly: e.onShopOnly === true || sig.onShopOnly === true ? true : null,
      shopFirm: e.shopFirm === true || sig.shopFirm === true ? true : null,
      shopDeclined: e.shopDeclined === true || sig.shopDeclined === true ? true : null,
      shopTone:
        e.shopTone === "annoyed" || sig.shopTone === "annoyed"
          ? "annoyed"
          : e.shopTone === "warm"
          ? "warm"
          : e.shopTone === "neutral"
          ? "neutral"
          : null,
      tags: Array.isArray(e.tags)
        ? e.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase().trim()).slice(0, 10)
        : [],
      mileageKm:
        typeof e.mileageKm === "number" && e.mileageKm > 0 && e.mileageKm < 1_000_000
          ? Math.round(e.mileageKm)
          : null,
      conditionNotes:
        typeof e.conditionNotes === "string" && e.conditionNotes.trim()
          ? e.conditionNotes.trim().slice(0, 200)
          : null,
      imageSummary:
        typeof e.imageSummary === "string" && e.imageSummary.trim()
          ? e.imageSummary.trim().slice(0, 500)
          : null,
      clarifyMessage: verifiedEnough
        ? undefined
        : e.clarifyMessage ||
          `Thanks! Could you confirm the exact daily price for the ${specStr}?`,
    };
  }
}

// Map a currency token found in text ("฿", "rp", "rm") to an ISO code.
function currencyFromToken(tok: string): string {
  const t = tok.toLowerCase();
  if (/\$|usd/.test(t)) return "USD";
  if (/฿|thb/.test(t)) return "THB";
  if (/€|eur/.test(t)) return "EUR";
  if (/rp|idr/.test(t)) return "IDR";
  if (/rm|myr/.test(t)) return "MYR";
  if (/₱|php/.test(t)) return "PHP";
  if (/₹|inr/.test(t)) return "INR";
  if (/₫|vnd/.test(t)) return "VND";
  return "USD";
}

/** Round a bargain target to a clean, human number (nearest 10, or 50/100 for
 *  larger amounts) so the agent asks for 220, not 213. */
export function roundNice(n: number): number {
  if (n <= 0) return n;
  if (n < 100) return Math.round(n / 10) * 10;
  if (n < 1000) return Math.round(n / 10) * 10;
  if (n < 10000) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
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

  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("triage");

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
  const { getPrompt } = await import("./prompts");
  const system = await getPrompt("writer");
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
  // For a CAR, seats + body type are the whole point of the check - the old
  // message dropped them and just said "car". Include them, plus the dates.
  const vehicle =
    rfq.vehicleClass === "car"
      ? [
          rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
          rfq.seats ? `${rfq.seats}-seat` : "",
          "car",
        ]
          .filter(Boolean)
          .join(" ")
      : `${vehicleTerm(rfq.vehicleClass)}${rfq.engineSizeCc ? ` (${rfq.engineSizeCc}cc)` : ""}`;
  const period = rfq.startDate
    ? `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"} from ${prettyDate(rfq.startDate)}`
    : `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  const checks = [
    vehicle,
    rfq.transmission !== "any" ? rfq.transmission : null,
    rfq.maxMileageKm ? `under ${rfq.maxMileageKm.toLocaleString()} km` : null,
    period,
    ...rfq.accessories,
  ].filter(Boolean);
  return (
    "Before we confirm, can you verify the vehicle matches: " +
    checks.join(", ") +
    "? Please confirm availability and the exact model. Thank you!"
  );
}
