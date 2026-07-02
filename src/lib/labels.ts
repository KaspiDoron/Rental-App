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
