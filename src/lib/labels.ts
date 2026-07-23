// Human-facing vocabulary. Internal ids stay stable ("scooter"/"motorbike");
// every label shown to users says "Automatic scooter" / "Manual motorcycle".

import type { VehicleClass } from "./types";

// The transmission is read from the RFQ when known, not hardcoded by class
// (F2 correctness bug): a manual scooter or automatic motorbike request used to
// render the wrong word. When transmission is absent/"any", fall back to the
// common default for that class (scooters are usually automatic, motorbikes
// manual) so existing callers without an RFQ are unchanged.
export function vehicleLabel(v: VehicleClass, transmission?: string): string {
  if (v === "car") return "Car";
  const isScooter = v === "scooter";
  const trans =
    transmission === "automatic"
      ? "Automatic"
      : transmission === "manual"
      ? "Manual"
      : isScooter
      ? "Automatic"
      : "Manual";
  return `${trans} ${isScooter ? "scooter" : "motorcycle"}`;
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
