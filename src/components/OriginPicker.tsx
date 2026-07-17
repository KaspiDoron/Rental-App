"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "./icons";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { useI18n } from "@/lib/i18n";

// Leaflet touches window - load the pin picker only when opened.
const OriginPinPicker = dynamic(() => import("./OriginPinPicker"), { ssr: false });

export interface Origin {
  label: string;
  lat: number;
  lng: number;
  // True when the coordinates came from the phone's GPS - the UI then shows
  // "My location" while `label` keeps the reverse-geocoded REAL place name
  // (the label is what drives local currency + language resolution).
  myLocation?: boolean;
}

// The traveller's hotel / stay picker. Thin wrapper over the shared
// PlaceAutocomplete (rich Google Places suggestions from 2 characters, plus
// one-tap "use my location"), PLUS a precise pin-drop mode on a live map. A
// picked place carries real coordinates, which the vendor search needs. Every
// traveller defaults to "My location" - the page asks for GPS on load; this
// picker is the manual override and the fallback when location permission is
// off.
export function OriginPicker({
  origin,
  onChange,
  hint,
  radiusKm = 5,
}: {
  origin: Origin | null;
  onChange: (o: Origin) => void;
  /** Attention nudge shown when a search was attempted without a location. */
  hint?: string | null;
  /** Current search radius - visualized around the dropped pin. */
  radiusKm?: number;
}) {
  const { t } = useI18n();
  const [pinOpen, setPinOpen] = useState(false);
  const resolvedPlace =
    origin?.myLocation && origin.label && origin.label !== "My current location"
      ? origin.label
      : null;
  return (
    <div>
      <PlaceAutocomplete
        label="Your hotel / stay"
        placeholder={
          origin ? (origin.myLocation ? "My location" : origin.label) : "Search hotel, address or area..."
        }
        showMyLocation
        onPick={(p) => onChange({ label: p.label, lat: p.lat, lng: p.lng })}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {origin ? (
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-soft">
            <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-savings" />
            {origin.myLocation ? (
              <span className="truncate">
                <span className="font-bold text-strong">📍 My location</span>
                {resolvedPlace && <span className="text-faint"> · {resolvedPlace}</span>}
              </span>
            ) : (
              <span className="truncate">{origin.label}</span>
            )}
          </div>
        ) : (
          <div
            className={`flex min-w-0 items-center gap-1.5 text-[12px] ${
              hint ? "font-bold text-brandred" : "text-faint"
            }`}
          >
            <Icon name="pin" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {hint ?? "Finding your location... or type your hotel / area."}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          className="chip shrink-0 rounded-xl border border-line px-2 py-1 text-[11px] font-extrabold text-brandblue hover:bg-brandblue-soft"
        >
          🗺️ {t("Drop a pin")}
        </button>
      </div>
      {pinOpen && (
        <OriginPinPicker
          initial={origin ? { lat: origin.lat, lng: origin.lng } : null}
          radiusKm={radiusKm}
          onConfirm={(o) => {
            onChange(o);
            setPinOpen(false);
          }}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
