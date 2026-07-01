// Seed vendor directory.
//
// In production these rows live in Supabase and represent OPTED-IN partner
// vendors who agreed to receive automated RFQs via the official WhatsApp Cloud
// API. For demo mode we synthesise a realistic directory around the user's
// chosen origin so the whole flow works with zero external services.

import { scatter } from "./geo";
import type { Vendor, VehicleClass, Fulfillment } from "./types";

const NAMES = [
  "Sunrise Wheels",
  "Coastal Rides",
  "Nomad Motors",
  "Blue Lagoon Rentals",
  "GreenGo Scooters",
  "Summit Auto Hire",
  "Island Cruiser Co.",
  "Verde Mobility",
  "Harbor Bikes",
  "Palm Route Rentals",
  "Old Town Motors",
  "Vista Vehicle Hire",
  "Loop City Scooters",
  "Tuktuk & Co",
  "Freedom Riders",
  "Azure Car Club",
];

function pick<T>(arr: T[], seed: number): T[] {
  return arr.filter((_, i) => (seed >> i) & 1);
}

const CLASS_SETS: VehicleClass[][] = [
  ["motorbike", "scooter"],
  ["car"],
  ["car", "motorbike", "scooter"],
  ["scooter"],
  ["car", "motorbike"],
];

const FULFILLMENT_SETS: Fulfillment[][] = [
  ["hotel-delivery", "in-store"],
  ["in-store"],
  ["hotel-delivery"],
];

/** Build a deterministic partner directory around an origin. */
export function seedVendors(origin: { lat: number; lng: number }): Vendor[] {
  return NAMES.map((name, i) => {
    const { lat, lng } = scatter(origin, i + 1, 9);
    const rating = Number((3.6 + ((i * 37) % 14) / 10).toFixed(1)); // 3.6..4.9
    return {
      id: `v${i + 1}`,
      name,
      lat,
      lng,
      rating: Math.min(4.9, rating),
      reviews: 40 + ((i * 53) % 460),
      vehicleClasses: CLASS_SETS[i % CLASS_SETS.length],
      fulfillment: FULFILLMENT_SETS[i % FULFILLMENT_SETS.length],
      whatsapp: `+100000000${(i + 10).toString().padStart(2, "0")}`,
      basePricePerDay: 14 + ((i * 7) % 46), // 14..59
      partner: true,
    } satisfies Vendor;
  });
}

/** Popular traveller hubs for the origin quick-picker. */
export const ORIGIN_PRESETS = [
  { label: "Bali · Canggu", lat: -8.6478, lng: 115.1385 },
  { label: "Lisbon · Baixa", lat: 38.7101, lng: -9.1391 },
  { label: "Chiang Mai · Old City", lat: 18.7883, lng: 98.9853 },
  { label: "Barcelona · Gothic", lat: 41.3833, lng: 2.1777 },
  { label: "Mexico City · Roma", lat: 19.4194, lng: -99.1607 },
];
