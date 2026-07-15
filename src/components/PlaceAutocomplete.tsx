"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface PlacePick {
  label: string;
  lat: number;
  lng: number;
}

// A dropdown row: Autocomplete predictions carry a placeId and get their
// coordinates resolved on pick; Text Search / Geocoding / OSM rows already
// carry real coordinates.
interface Suggestion {
  label: string;
  lat: number;
  lng: number;
  placeId?: string;
}

// One reusable, richly-suggesting location typeahead used EVERYWHERE the app
// asks for a place (traveller hotel, booking delivery / drop-off address,
// profile home city, admin market-floor area, admin training region). Real
// Google Places (New) Autocomplete suggestions via /api/geocode, with Text
// Search, Geocoding and OpenStreetMap fallbacks. It suggests from 2
// characters and shows up to ~10 options.
//
// Cost & responsiveness:
//  - a per-tab prefix cache means retyping the same query is free and instant
//  - a session token groups a whole typing session into ONE billed
//    autocomplete session, closed by the Place Details call on pick
//
// Two consumer shapes:
//  - Coordinate mode: pass `onPick` - fires with {label,lat,lng} when a
//    suggestion (or GPS) is chosen.
//  - Free-text mode: pass `onText` - fires on every keystroke with the raw
//    text (for fields that only need a string, no coordinates). Choosing a
//    suggestion also calls `onText(label)`.
// Pass both to get the picked coordinates AND keep the text in sync.

// Per-tab suggestion cache (query -> rows). Small and session-scoped: typing
// "Cang", deleting, retyping costs zero extra requests.
const SUGGESTION_CACHE = new Map<string, Suggestion[]>();
const CACHE_MAX = 80;

function newSessionToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `st-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

export function PlaceAutocomplete({
  label,
  placeholder = "Search hotel, address or area...",
  value,
  onPick,
  onText,
  showMyLocation = false,
  icon = "pin",
  minChars = 2,
  className = "",
}: {
  label?: string;
  placeholder?: string;
  /** Externally-known committed label (shown as the confirmed value + seeds the box). */
  value?: string;
  onPick?: (p: PlacePick) => void;
  onText?: (text: string) => void;
  showMyLocation?: boolean;
  icon?: string;
  minChars?: number;
  className?: string;
}) {
  const [query, setQuery] = useState(value ?? "");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const boxRef = useRef<HTMLDivElement>(null);
  // One autocomplete billing session per typing burst; renewed after a pick.
  const sessionToken = useRef<string>(newSessionToken());

  // Keep the box in sync when the parent changes the committed value.
  useEffect(() => {
    if (value !== undefined) setQuery(value);
  }, [value]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < minChars) {
      setResults([]);
      setNote(null);
      return;
    }
    // Instant, free answer for a query this tab already asked.
    const hit = SUGGESTION_CACHE.get(q.toLowerCase());
    if (hit) {
      setResults(hit);
      setNote(hit.length ? null : friendlyError(undefined, q));
      setOpen(true);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(q)}&st=${encodeURIComponent(sessionToken.current)}`
        );
        const data = await res.json();
        const list: Suggestion[] = (data.results ?? []).map((r: any) => ({
          label: r.label,
          lat: r.lat,
          lng: r.lng,
          placeId: r.placeId,
        }));
        if (SUGGESTION_CACHE.size > CACHE_MAX) SUGGESTION_CACHE.clear();
        if (list.length) SUGGESTION_CACHE.set(q.toLowerCase(), list);
        setResults(list);
        setNote(list.length ? null : friendlyError(data.error, q));
        setOpen(true);
      } catch {
        setResults([]);
        setNote("Could not reach location search. Check your connection and retry.");
        setOpen(true);
      } finally {
        setBusy(false);
      }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query, minChars]);

  // Close the dropdown on an outside tap.
  useEffect(() => {
    function onDocDown(e: PointerEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, []);

  function commit(p: PlacePick) {
    onText?.(p.label);
    onPick?.(p);
    setQuery(p.label);
    setResults([]);
    setOpen(false);
    setResolving(null);
    // Next typing burst is a fresh autocomplete billing session.
    sessionToken.current = newSessionToken();
  }

  async function choose(s: Suggestion) {
    // Free-text consumers get the label immediately either way.
    const hasCoords = Number.isFinite(s.lat) && (s.lat !== 0 || s.lng !== 0);
    if (hasCoords || !s.placeId) {
      commit({ label: s.label, lat: s.lat, lng: s.lng });
      return;
    }
    if (!onPick) {
      // Text-only field: no coordinates needed - never spend a Details call.
      commit({ label: s.label, lat: 0, lng: 0 });
      return;
    }
    // Autocomplete prediction: resolve coordinates with one Details call.
    setResolving(s.placeId);
    try {
      const res = await fetch(
        `/api/geocode?placeId=${encodeURIComponent(s.placeId)}&label=${encodeURIComponent(
          s.label
        )}&st=${encodeURIComponent(sessionToken.current)}`
      );
      const data = await res.json();
      if (data?.place && Number.isFinite(data.place.lat)) {
        commit({ label: s.label, lat: data.place.lat, lng: data.place.lng });
        return;
      }
      setNote("Could not pin that place on the map - try another suggestion.");
    } catch {
      setNote("Could not pin that place on the map - check your connection.");
    } finally {
      setResolving(null);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        // Turn the raw GPS point into a REAL named place so local currency and
        // language resolve (never leave it as "My current location").
        let lbl = "My current location";
        try {
          const res = await fetch(`/api/geocode?lat=${lat}&lng=${lng}`);
          const data = await res.json();
          if (data?.place?.label) lbl = data.place.label;
        } catch {
          /* keep fallback label - coordinates still drive the search */
        }
        commit({ label: lbl, lat, lng });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {label && <label className="text-[12px] font-bold text-soft">{label}</label>}
      <div className="mt-1 flex items-center gap-2 rounded-2xl border-2 border-line bg-card px-3 focus-within:border-brandblue">
        <Icon name={icon} className="h-4 w-4 shrink-0 text-brandred" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onText?.(e.target.value);
          }}
          onFocus={() => (results.length || note) && setOpen(true)}
          placeholder={placeholder}
          className="w-full bg-transparent py-3 text-[16px] text-strong placeholder:text-faint focus:outline-none"
        />
        {busy && (
          <span
            role="status"
            aria-label="Searching places"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-brandblue"
          />
        )}
      </div>

      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-2 max-h-72 overflow-y-auto overflow-x-hidden rounded-2xl surface-strong no-scrollbar">
          {showMyLocation && (
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
          )}
          {results.map((r, i) => (
            <button
              key={`${r.placeId ?? `${r.lat},${r.lng}`},${i}`}
              onClick={() => choose(r)}
              disabled={resolving !== null}
              className="btn btn-sm flex w-full items-start gap-2 border-t border-line px-4 py-3 text-left hover:bg-card2 disabled:opacity-60"
            >
              {resolving && resolving === r.placeId ? (
                <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brandblue/30 border-t-brandblue" />
              ) : (
                <Icon name="pin" className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
              )}
              <span className="text-[14px] leading-snug text-strong">{r.label}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="border-t border-line px-4 py-3 text-[13px] text-faint">
              {note ?? "Keep typing to search places..."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Map the route's error codes / Google reasons to something a traveller can act
// on. Unknown Google errors (key restrictions etc.) still show a hint so the
// dropdown is never mutely empty.
function friendlyError(error: string | undefined, q: string): string {
  if (!error) return `No matches for "${q}" - keep typing or use your area name.`;
  switch (error) {
    case "signed-out":
      return "Sign in to search locations.";
    case "paused":
      return "Location search is paused right now - type your area name to continue.";
    case "daily-limit":
      return "You have hit today's location-search limit - type your area name to continue.";
    default:
      // A real Google/network reason (e.g. Places API not enabled). Keep it
      // short and non-technical for users; the exact text still appears so an
      // owner testing the app can diagnose the key.
      return `Location search is limited right now (${error.slice(0, 80)}). Type your area name to continue.`;
  }
}
