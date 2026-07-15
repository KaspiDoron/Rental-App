// AI-generated test scenarios for the Playground: fresh, realistic rental
// shops to negotiate against. An LLM invents each one (region, vehicle,
// persona, opening line); a rich built-in pool keeps the feature fully
// working with zero keys. Once the owner tests a scenario it is replaced by
// a new suggestion - the test bench never goes stale.

import "server-only";
import { chat, extractJson } from "../ai";
import type { StructuredRFQ } from "../types";

export interface SuggestedScenario {
  id: string;
  label: string;
  region: string;
  rfq: Partial<StructuredRFQ>;
  rivalPricePerDay?: number;
  persona: string;
  /** The shop's first message, so the run starts instantly. */
  opening: string;
  fromAi: boolean;
}

// The keyless pool - varied enough to cover every branch of the playbook.
const POOL: Omit<SuggestedScenario, "id" | "fromAi">[] = [
  {
    label: "Aggressive opener, 2x the floor",
    region: "Phuket, Thailand",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    persona:
      "Tourist-strip shop, opens at 350 baht/day for a 125cc (floor is ~170), concedes slowly in 3 steps to 200, passport deposit preferred, 5000 cash accepted, free delivery over 3 days.",
    opening: "125cc yes have. 350 baht per day, helmet include.",
  },
  {
    label: "Friendly but firm from message one",
    region: "Chiang Mai, Thailand",
    rfq: { vehicleClass: "scooter", engineSizeCc: 110, durationDays: 7 },
    persona:
      "Family shop, very warm tone with emojis, 200 baht/day fixed - genuinely never lowers (says 'same price for everyone'), 3000 cash deposit, shop pickup only.",
    opening: "Hello ka 😊 Honda Click 200 baht per day, same price for everyone na.",
  },
  {
    label: "Quotes the weekly TOTAL (arithmetic trap)",
    region: "Canggu, Bali, Indonesia",
    rfq: { vehicleClass: "scooter", engineSizeCc: 125, durationDays: 7 },
    persona:
      "Beach shop, quotes totals not per-day ('700k for the week'), real bottom 80k/day, no-deposit if paid upfront, delivers free around Canggu.",
    opening: "Vario 125 ready bro. 700 for one week.",
  },
  {
    label: "Passport-only hardliner",
    region: "Koh Samui, Thailand",
    rfq: { vehicleClass: "scooter", engineSizeCc: 155, durationDays: 3 },
    persona:
      "Insists on passport deposit ('everybody give passport'), only accepts 6000 cash after two polite pushes, Nmax at 450/day with bottom 350, on-shop only.",
    opening: "Nmax 450 per day. Need passport keep in shop.",
  },
  {
    label: "Old bike / new bike two-tier",
    region: "Pai, Thailand",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    persona:
      "Offers an old Wave 150/day (scratches, 40000 km) and a new one 250/day (bottom 200). Mentions mileage only if asked. 2000 cash deposit either way.",
    opening: "Have new model 250 baht, old model 150 baht. Old one still strong.",
  },
  {
    label: "Voice-note lover, heavy accent",
    region: "Hanoi, Vietnam",
    rfq: { vehicleClass: "scooter", engineSizeCc: 110, durationDays: 5 },
    persona:
      "Prefers answering by voice note (write '(voice note) ...' style replies), 150k dong/day bottom 120k, ID card or 2 million dong deposit, delivers for 50k.",
    opening: "(voice note) Hello my friend, Honda Vision have, one day one hundred fifty, you take long time I make good price.",
  },
  {
    label: "Slow replier who tests patience",
    region: "Lombok, Indonesia",
    rfq: { vehicleClass: "scooter", engineSizeCc: 125, durationDays: 3 },
    persona:
      "Replies short and slow, 90k/day opener with bottom 70k, only concedes when the traveller looks ready to walk away, 500k cash deposit, hotel delivery 20k.",
    opening: "90 per day.",
  },
  {
    label: "Upseller pushing the bigger bike",
    region: "Krabi, Thailand",
    rfq: { vehicleClass: "scooter", engineSizeCc: 110, durationDays: 3 },
    persona:
      "Keeps pushing an Nmax 155 at 400/day instead of the requested 110cc (Click at 200, bottom 160). Gives the Click price only when asked twice. 3000 cash deposit, free delivery.",
    opening: "Better you take Nmax 155, very smooth, 400 baht only!",
  },
  {
    label: "Gets annoyed after one push",
    region: "Ho Chi Minh City, Vietnam",
    rfq: { vehicleClass: "motorbike", engineSizeCc: 125, durationDays: 3 },
    persona:
      "Proud shop, 180k/day (bottom 160k). After ONE price push becomes short and annoyed ('go to them then'). License + 1 million dong deposit, on-shop only.",
    opening: "Winner X 180 per day, good bike, no problem.",
  },
  {
    label: "Photo-first shop (price sheet)",
    region: "Ubud, Bali, Indonesia",
    rfq: { vehicleClass: "scooter", engineSizeCc: 125, durationDays: 3 },
    persona:
      "Answers questions by sending photos - describe sending a price board (many models with prices) instead of typing. Scoopy 80k/day bottom 65k, passport or 1 million deposit.",
    opening: "(sends a photo of the price board: Scoopy 80k, Vario 90k, Nmax 130k per day, deposit passport or 1.000.000)",
  },
];

/** Generate one fresh scenario, avoiding labels the owner already tested. */
export async function suggestScenario(exclude: string[]): Promise<SuggestedScenario> {
  const used = new Set(exclude.map((s) => s.toLowerCase()));
  const out = await chat(
    [
      {
        role: "system",
        content:
          "You invent ONE realistic Southeast-Asia vehicle-rental shop for testing a negotiation " +
          "agent. Make it genuinely different from the excluded ones - vary region, vehicle, " +
          "personality, tactics (firm/slow/upsell/total-quoter/annoyed/voice-notes/photos), " +
          "deposit style and price gap vs the local floor. Reply ONLY as JSON: " +
          '{ "label": "short catchy name", "region": "City, Country", ' +
          '"vehicleClass": "scooter"|"motorbike", "engineSizeCc": number, "durationDays": 1|3|7, ' +
          '"persona": "2-3 sentences: opening price, real bottom, deposit style, delivery, temperament", ' +
          '"opening": "the shop\'s first WhatsApp message, in-character" }',
      },
      {
        role: "user",
        content: `Already tested (avoid similar): ${exclude.slice(0, 12).join("; ") || "(none yet)"}`,
      },
    ],
    { maxTokens: 320 }
  );
  if (out) {
    const p = extractJson<{
      label?: string;
      region?: string;
      vehicleClass?: string;
      engineSizeCc?: number;
      durationDays?: number;
      persona?: string;
      opening?: string;
    }>(out);
    if (p?.label && p.persona && p.region) {
      return {
        id: `ai-${Math.abs(hash(p.label))}`,
        label: String(p.label).slice(0, 60),
        region: String(p.region).slice(0, 80),
        rfq: {
          vehicleClass: p.vehicleClass === "motorbike" ? "motorbike" : "scooter",
          engineSizeCc:
            Number.isFinite(Number(p.engineSizeCc)) && Number(p.engineSizeCc) > 0
              ? Math.round(Number(p.engineSizeCc))
              : 125,
          durationDays: [1, 3, 7].includes(Number(p.durationDays)) ? Number(p.durationDays) : 3,
        },
        persona: String(p.persona).slice(0, 600),
        opening: String(p.opening ?? "Hello, yes have bike.").slice(0, 300),
        fromAi: true,
      };
    }
  }
  // Keyless fallback: the first pool entry not tested yet (then wrap around).
  const fresh = POOL.find((s) => !used.has(s.label.toLowerCase())) ?? POOL[exclude.length % POOL.length];
  return { ...fresh, id: `pool-${Math.abs(hash(fresh.label))}`, fromAi: false };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
