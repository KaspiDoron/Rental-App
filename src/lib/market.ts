// Market Floor Intelligence - the owner-visible table of the LOWEST realistic
// daily rental prices per area, split by vehicle bucket (scooter/motorbike cc
// bands + car body types). The bargaining agent asks ONCE for a target price
// anchored to this floor so it never proposes absurd lowballs (a 70 THB/day
// scooter does not exist) and never needs a second push.
//
// Smart storage: we do NOT save prices for every town on earth. Prices are
// keyed at two levels - a coarse AREA key (e.g. "koh samui, thailand") and a
// COUNTRY key ("thailand") as fallback - and rows are refreshed by real web
// research at most once every 3 weeks, lazily, the first time someone searches
// in that area (then re-used instantly on every later visit to that area).

import "server-only";
import { sbSelect, sbInsert, sbUpdate } from "./runtime-config";
import { chat, chatGrounded, extractJson } from "./ai";
import { currencyForRegion } from "./agents";
import type { StructuredRFQ } from "./types";

export interface FloorRow {
  id?: number;
  region_key: string;
  vehicle_key: string;
  currency: string;
  floor_per_day: number;
  typical_per_day: number | null;
  source: string; // "ai" | "owner"
  updated_at?: string;
}

// Every vehicle variation we track. Scooters/motorbikes bucket by cc band;
// cars bucket by body type. This keeps the table small and universal.
export const VEHICLE_KEYS = [
  "scooter-110", // 100-115cc automatic (Click/Scoopy class)
  "scooter-125", // 125cc automatic
  "scooter-160", // 150-160cc automatic (NMax/PCX class)
  "motorbike-150", // small manual
  "motorbike-300", // 200-300cc manual
  "motorbike-500", // 400-500cc manual
  "motorbike-big", // 650cc+ manual
  "car-economy",
  "car-sedan",
  "car-suv",
  "car-van",
  "car-luxury",
] as const;

export function vehicleKeyFor(rfq: StructuredRFQ): string {
  if (rfq.vehicleClass === "car") {
    const t = rfq.carType && rfq.carType !== "any" ? rfq.carType : "economy";
    return `car-${t}`;
  }
  const cc = rfq.engineSizeCc ?? (rfq.vehicleClass === "scooter" ? 125 : 150);
  if (rfq.vehicleClass === "scooter") {
    return cc <= 115 ? "scooter-110" : cc <= 140 ? "scooter-125" : "scooter-160";
  }
  return cc <= 175 ? "motorbike-150" : cc <= 300 ? "motorbike-300" : cc <= 550 ? "motorbike-500" : "motorbike-big";
}

/** ["koh samui, thailand", "thailand"] - area first, country fallback. */
export function regionKeysFor(region?: string): string[] {
  if (!region) return [];
  const parts = region
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const country = parts[parts.length - 1];
  // Area = first locality + country, so "Bophut, Koh Samui, Thailand" and
  // "Maenam, Koh Samui, Thailand" share the "koh samui, thailand" row.
  const locality = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const area = locality === country ? country : `${locality}, ${country}`;
  return area === country ? [country] : [area, country];
}

const FRESH_MS = 21 * 24 * 3600_000; // web-research refresh cadence: every 3 weeks

/**
 * Lowest realistic daily price for this spec near this region.
 * Triggers a lazy AI refresh (once a week per area) when data is missing/stale.
 */
export async function floorPriceFor(
  region: string | undefined,
  rfq: StructuredRFQ
): Promise<{ floor: number; typical: number | null; currency: string } | null> {
  const keys = regionKeysFor(region);
  if (!keys.length) return null;
  const vkey = vehicleKeyFor(rfq);

  const rows = await sbSelect<FloorRow>(
    "market_floor_prices",
    `select=region_key,vehicle_key,currency,floor_per_day,typical_per_day,updated_at&vehicle_key=eq.${encodeURIComponent(
      vkey
    )}&region_key=in.(${keys.map((k) => `"${k}"`).join(",")})&limit=4`
  );
  // Prefer the most specific (area) row.
  const row =
    rows.find((r) => r.region_key === keys[0]) ??
    rows.find((r) => r.region_key === keys[1]);

  const stale =
    !row ||
    (row.updated_at ? Date.now() - Date.parse(row.updated_at) > FRESH_MS : false);
  if (stale) {
    // Fire-and-forget: next search gets fresh numbers; this one still gets the
    // old row (or the deterministic default below) with zero added latency.
    refreshRegionFloors(keys[0]).catch(() => {});
  }
  if (row && row.floor_per_day > 0) {
    return { floor: row.floor_per_day, typical: row.typical_per_day, currency: row.currency };
  }
  return defaultFloor(region, vkey);
}

// Researched per-country seed: the LOWEST realistic walk-in price for a 125cc
// automatic scooter, per day, in LOCAL currency (low season, multi-day, cash).
// Keys match the lowercase country name regionKeysFor() extracts from labels.
// These seed the hints and the agent's sanity floor before the weekly AI
// research replaces them with area-accurate rows.
const COUNTRY_SCOOTER_FLOOR: Record<string, { cur: string; perDay: number }> = {
  thailand: { cur: "THB", perDay: 150 },
  indonesia: { cur: "IDR", perDay: 50000 },
  vietnam: { cur: "VND", perDay: 100000 },
  philippines: { cur: "PHP", perDay: 350 },
  malaysia: { cur: "MYR", perDay: 25 },
  india: { cur: "INR", perDay: 400 },
  "sri lanka": { cur: "LKR", perDay: 2500 },
  nepal: { cur: "NPR", perDay: 1000 },
  taiwan: { cur: "TWD", perDay: 400 },
  japan: { cur: "JPY", perDay: 4000 },
  "south korea": { cur: "KRW", perDay: 30000 },
  singapore: { cur: "SGD", perDay: 50 },
  greece: { cur: "EUR", perDay: 15 },
  spain: { cur: "EUR", perDay: 18 },
  portugal: { cur: "EUR", perDay: 15 },
  italy: { cur: "EUR", perDay: 20 },
  france: { cur: "EUR", perDay: 25 },
  croatia: { cur: "EUR", perDay: 20 },
  cyprus: { cur: "EUR", perDay: 15 },
  malta: { cur: "EUR", perDay: 18 },
  turkey: { cur: "TRY", perDay: 400 },
  israel: { cur: "ILS", perDay: 120 },
  mexico: { cur: "MXN", perDay: 350 },
  brazil: { cur: "BRL", perDay: 80 },
  morocco: { cur: "MAD", perDay: 150 },
  egypt: { cur: "EGP", perDay: 250 },
  "south africa": { cur: "ZAR", perDay: 250 },
  australia: { cur: "AUD", perDay: 40 },
  "new zealand": { cur: "NZD", perDay: 40 },
  "united states": { cur: "USD", perDay: 35 },
  usa: { cur: "USD", perDay: 35 },
  "united arab emirates": { cur: "AED", perDay: 100 },
};

// How each vehicle bucket prices relative to a 125cc scooter (=1.0). Rough but
// consistent worldwide - real area rows from the AI refresh override these.
const VEHICLE_RATIO: Record<string, number> = {
  "scooter-110": 0.8, "scooter-125": 1, "scooter-160": 1.4,
  "motorbike-150": 1.2, "motorbike-300": 2.4, "motorbike-500": 4, "motorbike-big": 6,
  "car-economy": 3.6, "car-sedan": 5, "car-suv": 6.4, "car-van": 7.6, "car-luxury": 12,
};

// Conservative built-in floors (per day, LOCAL currency) so the agent is sane
// even before the AI has researched an area. Deliberately on the low-but-real
// side; the AI refresh replaces them with area-accurate numbers.
function defaultFloor(
  region: string | undefined,
  vkey: string
): { floor: number; typical: number | null; currency: string } | null {
  const ratio = VEHICLE_RATIO[vkey];
  if (!ratio) return null;
  // Country-researched seed first - the most accurate zero-AI answer we have.
  const country = regionKeysFor(region).pop();
  const seed = country ? COUNTRY_SCOOTER_FLOOR[country] : undefined;
  if (seed) {
    const floor = Math.round(seed.perDay * ratio);
    return { floor, typical: Math.round(floor * 1.6), currency: seed.cur };
  }
  const cur = currencyForRegion(region) ?? "USD";
  // Fallback: USD baseline converted by rough purchasing-power multipliers.
  const usd: Record<string, number> = {
    "scooter-110": 4, "scooter-125": 5, "scooter-160": 7,
    "motorbike-150": 6, "motorbike-300": 12, "motorbike-500": 20, "motorbike-big": 30,
    "car-economy": 18, "car-sedan": 25, "car-suv": 32, "car-van": 38, "car-luxury": 60,
  };
  const fx: Record<string, number> = {
    USD: 1, EUR: 0.95, GBP: 0.8, THB: 36, IDR: 16000, VND: 25000, INR: 84,
    JPY: 150, PHP: 58, MYR: 4.6, TRY: 34, MXN: 18, ILS: 3.7,
  };
  const base = usd[vkey];
  if (!base || !fx[cur]) return null;
  const floor = Math.round(base * fx[cur]);
  return { floor, typical: Math.round(floor * 1.5), currency: cur };
}

/**
 * Web-grounded research (every 3 weeks per area): find the honest LOWEST and
 * typical daily rental price for every vehicle bucket in one area, in the local
 * currency, by SEARCHING THE WEB, and upsert the rows. Anchored to the cheapest
 * real vehicles - a 110cc automatic scooter and a small 4-seat economy car.
 * Prefers Gemini's Google-Search grounding (real listings); falls back to an
 * ungrounded model estimate when no Gemini key is set. Owner edits always win.
 */
export async function refreshRegionFloors(regionKey: string): Promise<boolean> {
  const cur = currencyForRegion(regionKey) ?? "USD";
  const system =
    "You are a vehicle-rental market analyst. SEARCH THE WEB for current rental " +
    "listings and prices in the given area, then report the LOWEST realistic " +
    "daily price a local shop actually accepts (low season, multi-day, cash) and " +
    `the TYPICAL walk-in daily price, in ${cur}, for each vehicle key. Anchor the ` +
    "cheapest tiers on the smallest real vehicles: 'scooter-110' = a 110cc " +
    "automatic scooter (Honda Click / Scoopy class), 'car-economy' = a small " +
    "4-seat economy hatchback. Never quote fantasy lows a shop would laugh at. " +
    'Reply ONLY as JSON: { "prices": [ { "key": string, "floor": number, ' +
    '"typical": number } ] } covering exactly these keys: ' +
    VEHICLE_KEYS.join(", ") + ".";
  const userMsg = `Area: ${regionKey}. Currency: ${cur}. Search the web for today's real rental prices there.`;

  // 1) Real web grounding (Gemini + Google Search). 2) Ungrounded estimate.
  let text: string | null = null;
  let source = "web";
  const grounded = await chatGrounded(system, userMsg);
  if (grounded?.text) {
    text = grounded.text;
  } else {
    text = await chat([
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ]);
    source = "ai";
  }
  if (!text) return false;
  const parsed = extractJson<{ prices: { key: string; floor: number; typical: number }[] }>(text);
  if (!parsed?.prices?.length) return false;

  const existing = await sbSelect<FloorRow>(
    "market_floor_prices",
    `select=id,vehicle_key,source&region_key=eq.${encodeURIComponent(regionKey)}&limit=50`
  );
  for (const p of parsed.prices) {
    if (!VEHICLE_KEYS.includes(p.key as (typeof VEHICLE_KEYS)[number])) continue;
    if (!(p.floor > 0)) continue;
    const prior = existing.find((e) => e.vehicle_key === p.key);
    if (prior?.source === "owner") continue; // owner overrides always win
    const values = {
      region_key: regionKey,
      vehicle_key: p.key,
      currency: cur,
      floor_per_day: Math.round(p.floor),
      typical_per_day: p.typical > 0 ? Math.round(p.typical) : null,
      source,
      updated_at: new Date().toISOString(),
    };
    if (prior?.id) {
      await sbUpdate("market_floor_prices", `id=eq.${prior.id}`, values);
    } else {
      await sbInsert("market_floor_prices", [values]);
    }
  }
  return true;
}

/** Owner table view: all researched areas + rows. */
export async function listFloors(): Promise<FloorRow[]> {
  return sbSelect<FloorRow>(
    "market_floor_prices",
    "select=id,region_key,vehicle_key,currency,floor_per_day,typical_per_day,source,updated_at&order=region_key.asc,vehicle_key.asc&limit=500"
  );
}

/** Owner edit: set a floor by hand (survives AI refreshes). */
export async function ownerSetFloor(
  id: number,
  floor: number,
  typical?: number | null
): Promise<void> {
  await sbUpdate("market_floor_prices", `id=eq.${id}`, {
    floor_per_day: Math.round(floor),
    ...(typical !== undefined ? { typical_per_day: typical } : {}),
    source: "owner",
    updated_at: new Date().toISOString(),
  });
}
