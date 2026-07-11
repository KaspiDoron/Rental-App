"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface Origin {
  label: string;
  lat: number;
  lng: number;
}

// Real address search for the traveller's hotel / stay: debounced queries to
// /api/geocode (Google Geocoding when configured, OpenStreetMap otherwise),
// plus one-tap "use my location".
export function OriginPicker({
  origin,
  onChange,
}: {
  origin: Origin | null;
  onChange: (o: Origin) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Origin[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(
          (data.results ?? []).map((r: any) => ({
            label: r.label,
            lat: r.lat,
            lng: r.lng,
          }))
        );
        setOpen(true);
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [query]);

  const [locating, setLocating] = useState(false);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        // Turn the raw GPS point into a REAL named place so the local currency
        // and language resolve correctly (never leave it as "My current
        // location", which no country/currency map can read).
        let label = "My current location";
        try {
          const res = await fetch(`/api/geocode?lat=${lat}&lng=${lng}`);
          const data = await res.json();
          if (data?.place?.label) label = data.place.label;
        } catch {
          /* keep the fallback label - coordinates still drive the search */
        }
        onChange({ label, lat, lng });
        setLocating(false);
        setOpen(false);
        setQuery("");
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  return (
    <div className="relative">
      <label className="text-[12px] font-bold text-soft">
        Your hotel / stay
      </label>
      <div className="mt-1 flex items-center gap-2 rounded-2xl border-2 border-line bg-card px-3 focus-within:border-brandblue">
        <Icon name="pin" className="h-4 w-4 shrink-0 text-brandred" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          placeholder={origin ? origin.label : "Search hotel, address or area..."}
          className="w-full bg-transparent py-3 text-[15px] text-strong placeholder:text-faint focus:outline-none"
        />
        {busy && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-brandblue" />}
      </div>

      {origin && !open && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-soft">
          <Icon name="check" className="h-3.5 w-3.5 text-savings" />
          <span className="truncate">{origin.label}</span>
        </div>
      )}

      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-2xl surface-strong">
          <button
            onClick={useMyLocation}
            disabled={locating}
            className="btn btn-sm flex w-full items-center gap-2 px-4 py-3 text-left text-[14px] font-bold text-brandblue hover:bg-brandblue-soft disabled:opacity-60"
          >
            {locating ? (
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brandblue/30 border-t-brandblue" />
            ) : (
              <Icon name="spark" className="h-4 w-4" />
            )}
            {locating ? "Finding your location..." : "Use my current location"}
          </button>
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => {
                onChange(r);
                setOpen(false);
                setQuery("");
              }}
              className="btn btn-sm flex w-full items-start gap-2 border-t border-line px-4 py-3 text-left hover:bg-card2"
            >
              <Icon name="pin" className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
              <span className="text-[13px] leading-snug text-strong">{r.label}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="border-t border-line px-4 py-3 text-[13px] text-faint">
              Keep typing to search places...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
