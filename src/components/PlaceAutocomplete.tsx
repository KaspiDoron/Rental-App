"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { OrbitDots } from "./OrbitDots";

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
  onDenied,
}: {
  label?: string;
  placeholder?: string;
  /** Externally-known committed label (shown as the confirmed value + seeds the box). */
  value?: string;
  onPick?: (p: PlacePick) => void;
  onText?: (text: string) => void;
  /** Device location was refused or unavailable. The caller can fall back to
   *  the search origin instead of leaving the traveller with a dead control. */
  onDenied?: () => void;
  showMyLocation?: boolean;
  icon?: string;
  minChars?: number;
  className?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(value ?? "");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** Monotonic request token - only the newest turn may write to the UI. */
  const turnRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
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
      setNote(hit.length ? null : friendlyError(t, undefined, q));
      setOpen(true);
      return;
    }
    clearTimeout(timer.current);
    // A STALE RESPONSE COULD SET THE SEARCH ORIGIN.
    //
    // The debounce cleared the TIMER but never cancelled the in-flight fetch,
    // and the handler called setResults unconditionally with no check that `q`
    // was still the current query. On a slow connection, typing a hotel name
    // showed suggestions for an earlier prefix - and OriginPicker feeds a tap
    // straight into onChange({label, lat, lng}), so the whole shop discovery
    // then ran around the wrong COORDINATES with nothing on screen to say so.
    //
    // Two guards, because either alone leaks: abort so a superseded request
    // stops costing a billed Place call, and compare the token so a response
    // that wins the race anyway cannot write.
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const myTurn = ++turnRef.current;
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(q)}&st=${encodeURIComponent(sessionToken.current)}`,
          { signal: ctrl.signal }
        );
        const data = await res.json();
        // Superseded while in flight - the cache write below is still correct
        // (it is keyed by ITS OWN query), but nothing may touch the UI.
        if (myTurn !== turnRef.current) {
          if (Array.isArray(data.results) && data.results.length) {
            SUGGESTION_CACHE.set(
              q.toLowerCase(),
              (data.results as { label: string; lat: number; lng: number; placeId?: string }[]).map(
                (r) => ({ label: r.label, lat: r.lat, lng: r.lng, placeId: r.placeId })
              )
            );
          }
          return;
        }
        const list: Suggestion[] = (data.results ?? []).map((r: any) => ({
          label: r.label,
          lat: r.lat,
          lng: r.lng,
          placeId: r.placeId,
        }));
        if (SUGGESTION_CACHE.size > CACHE_MAX) SUGGESTION_CACHE.clear();
        if (list.length) SUGGESTION_CACHE.set(q.toLowerCase(), list);
        setResults(list);
        setNote(list.length ? null : friendlyError(t, data.error, q));
        setOpen(true);
      } catch (e) {
        // An abort is us superseding ourselves, not a failure to report.
        if ((e as { name?: string })?.name === "AbortError") return;
        if (myTurn !== turnRef.current) return;
        setResults([]);
        setNote(t("Could not reach location search. Check your connection and retry."));
        setOpen(true);
      } finally {
        if (myTurn === turnRef.current) setBusy(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer.current);
      ctrl.abort();
    };
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
      setNote(t("Could not pin that place on the map - try another suggestion."));
    } catch {
      setNote(t("Could not pin that place on the map - check your connection."));
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
        let lbl = t("My current location");
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
      // A DENIED PERMISSION IS NOT A DEAD END, and it must never be silent.
      //
      // This used to be a bare `setLocating(false)`: the spinner stopped, the
      // field stayed empty, and nothing said why - so a traveller who had
      // declined the browser prompt (or was indoors with no fix) was left
      // staring at a control that looked broken, mid-way through arranging a
      // delivery. Every one of these cases has the same honest answer: type
      // the place instead, which is what the field beside it is for.
      (err: GeolocationPositionError) => {
        setLocating(false);
        setNote(
          err?.code === 1
            ? t("Location access is off for this site - type your hotel or area below instead and I'll use that.")
            : err?.code === 3
              ? t("Your phone could not get a fix in time - type your hotel or area below instead.")
              : t("Could not read your location - type your hotel or area below instead.")
        );
        setOpen(true);
        onDenied?.();
      },
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
          placeholder={t(placeholder)}
          className="w-full bg-transparent py-3 text-[16px] text-strong placeholder:text-faint focus:outline-none"
        />
        {busy && (
          <OrbitDots size={16} className="shrink-0 text-brandblue" label="Searching places" />
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
                <OrbitDots size={16} className="shrink-0 text-brandblue" label="Finding your location" />
              ) : (
                <Icon name="spark" className="h-4 w-4" />
              )}
              {locating ? t("Finding your location...") : t("Use my current location")}
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
                <OrbitDots size={16} className="mt-0.5 shrink-0 text-brandblue" label="Resolving place" />
              ) : (
                <Icon name="pin" className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
              )}
              <span className="text-[14px] leading-snug text-strong">{r.label}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="border-t border-line px-4 py-3 text-[13px] text-faint">
              {note ?? t("Keep typing to search places...")}
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
function friendlyError(
  t: (s: string) => string,
  error: string | undefined,
  q: string
): string {
  // The query rides OUTSIDE the translated sentence: the catalogue translates
  // exact strings, and a sentence with a user-typed fragment inside it could
  // never match one (and must never be uploaded - it is the user's own text).
  if (!error) return `${t("No matches for")} "${q}" - ${t("keep typing or use your area name.")}`;
  switch (error) {
    case "signed-out":
      return t("Sign in to search locations.");
    case "paused":
      return t("Location search is paused right now - type your area name to continue.");
    case "daily-limit":
      return t("You have hit today's location-search limit - type your area name to continue.");
    default:
      // A real Google/network reason (e.g. Places API not enabled). Keep it
      // short and non-technical for users; the exact text still appears so an
      // owner testing the app can diagnose the key.
      return `${t("Location search is limited right now")} (${error.slice(0, 80)}). ${t("Type your area name to continue.")}`;
  }
}
