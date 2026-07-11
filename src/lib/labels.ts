// Human-facing vocabulary. Internal ids stay stable ("scooter"/"motorbike");
// every label shown to users says "Automatic scooter" / "Manual motorcycle".

import type { VehicleClass } from "./types";

export function vehicleLabel(v: VehicleClass): string {
  switch (v) {
    case "scooter":
      return "Automatic scooter";
    case "motorbike":
      return "Manual motorcycle";
    default:
      return "Car";
  }
}

// Verified reply-based shop tags (item #13): id -> traveller-facing chip.
// Ids match VENDOR_TAG_VOCAB in vendor-tags.ts (server-only, so kept apart).
export const VENDOR_TAG_LABELS: Record<string, { emoji: string; label: string }> = {
  "delivery": { emoji: "🛵", label: "Delivers to you" },
  "pickup-only": { emoji: "🏪", label: "Pickup at shop" },
  "airport-delivery": { emoji: "✈️", label: "Airport delivery" },
  "no-deposit": { emoji: "🎉", label: "No deposit" },
  "passport-deposit": { emoji: "🛂", label: "Passport deposit" },
  "cash-deposit": { emoji: "💵", label: "Cash deposit" },
  "helmets-included": { emoji: "🪖", label: "Helmets included" },
  "insurance-included": { emoji: "🛡️", label: "Insurance included" },
  "cards-accepted": { emoji: "💳", label: "Cards accepted" },
  "flexible-dates": { emoji: "📅", label: "Flexible dates" },
};

export function vehicleLabelPlural(v: VehicleClass): string {
  switch (v) {
    case "scooter":
      return "Automatic scooters";
    case "motorbike":
      return "Manual motorcycles";
    default:
      return "Cars";
  }
}
