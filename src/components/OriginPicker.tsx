"use client";

import { Icon } from "./icons";
import { PlaceAutocomplete } from "./PlaceAutocomplete";

export interface Origin {
  label: string;
  lat: number;
  lng: number;
}

// The traveller's hotel / stay picker. Thin wrapper over the shared
// PlaceAutocomplete (rich Google Places suggestions from 2 characters, plus
// one-tap "use my location"). A picked place carries real coordinates, which
// the vendor search needs.
export function OriginPicker({
  origin,
  onChange,
}: {
  origin: Origin | null;
  onChange: (o: Origin) => void;
}) {
  return (
    <div>
      <PlaceAutocomplete
        label="Your hotel / stay"
        placeholder={origin ? origin.label : "Search hotel, address or area..."}
        showMyLocation
        onPick={(p) => onChange({ label: p.label, lat: p.lat, lng: p.lng })}
      />
      {origin && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-soft">
          <Icon name="check" className="h-3.5 w-3.5 text-savings" />
          <span className="truncate">{origin.label}</span>
        </div>
      )}
    </div>
  );
}
