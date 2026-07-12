// Google Maps Platform integration (server-side only - the key never reaches
// the browser; all calls are proxied through our API routes).
//
// IMPORTANT: keys created recently only work with "Places API (New)"
// (places.googleapis.com). We therefore call the NEW API first and fall back
// to the legacy endpoints for old keys. Errors are never swallowed - the
// exact Google status is surfaced so the admin can fix the key/console setup.
//
// With GOOGLE_MAPS_API_KEY configured:
//   - address/hotel search uses Places Text Search (finds hotels, POIs,
//     addresses - much better than plain geocoding), with Geocoding + OSM
//     Nominatim fallbacks
//   - vendor discovery uses Places Text Search around the stay (real rental
//     businesses)
//   - reviews/phone come from Place Details
//   - photos stream through /api/photo
// Without it, geocoding falls back to OpenStreetMap Nominatim (free, real
// data), and vendors fall back to clearly-labelled demo seeds.

import "server-only";
import { getConfig } from "./runtime-config";
import { haversineKm } from "./geo";
import { cacheGet, cacheSet, recordApi } from "./usage";
import type { Vendor, VehicleClass, VendorReview } from "./types";

export async function mapsKey(): Promise<string | undefined> {
  return getConfig("GOOGLE_MAPS_API_KEY");
}

const NEW_BASE = "https://places.googleapis.com/v1";

// ---- Geocoding / address search ---------------------------------------------

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
  source: "google" | "osm";
}

/** Places API (New) Text Search - also the best "find my hotel" search. */
async function newTextSearch(
  key: string,
  body: Record<string, unknown>,
  fieldMask: string
): Promise<{ places: any[] | null; error?: string }> {
  try {
    const res = await fetch(`${NEW_BASE}/places:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        places: null,
        error:
          data?.error?.message ??
          `Places API (New) responded ${res.status} - enable "Places API (New)" for this key in Google Cloud Console.`,
      };
    }
    return { places: (data.places as any[]) ?? [] };
  } catch (e) {
    return {
      places: null,
      error: e instanceof Error ? e.message : "network error reaching Google",
    };
  }
}

export interface PlaceSearchResult {
  results: PlaceSuggestion[];
  // When a Maps key IS set but every Google path failed, this carries the exact
  // Google reason so the picker can tell the owner how to fix the key (instead
  // of a mute empty dropdown). Never set when we have results.
  error?: string;
}

// Up to 10 rich suggestions per query so 2-letter typing shows a full list.
const MAX_SUGGESTIONS = 10;

// A descriptive, contactable User-Agent keeps Nominatim from throttling us as
// aggressively (their policy requires identifying the app). Include the deploy
// origin when we know it.
function nominatimUA(): string {
  const site =
    process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || "wheeldeal.app";
  return `WheelDeal/1.0 (vehicle-rental app; ${site})`;
}

export async function searchPlaces(q: string): Promise<PlaceSearchResult> {
  const key = await mapsKey();

  // Cache identical queries for a day - address text never changes that fast,
  // and every cache hit is a free request.
  const ck = `sp:${q.trim().toLowerCase()}`;
  const cached = cacheGet<PlaceSuggestion[]>(ck);
  if (cached) return { results: cached };

  let googleError: string | undefined;

  if (key) {
    // 1) Places API (New) Text Search: finds hotels, businesses, addresses.
    const { places, error } = await newTextSearch(
      key,
      { textQuery: q, maxResultCount: MAX_SUGGESTIONS },
      "places.displayName,places.formattedAddress,places.location"
    );
    await recordApi("places_search");
    if (error) googleError = error;
    if (places && places.length) {
      const out = places.map((p) => ({
        label: [p.displayName?.text, p.formattedAddress]
          .filter(Boolean)
          .join(" - "),
        lat: p.location?.latitude ?? 0,
        lng: p.location?.longitude ?? 0,
        source: "google" as const,
      }));
      cacheSet(ck, out, 24 * 3600_000);
      return { results: out };
    }

    // 2) Legacy Geocoding (works on older keys).
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
          q
        )}&key=${key}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      await recordApi("geocoding");
      if (data.status === "OK") {
        const out = (data.results as any[]).slice(0, MAX_SUGGESTIONS).map((r) => ({
          label: r.formatted_address,
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          source: "google" as const,
        }));
        cacheSet(ck, out, 24 * 3600_000);
        return { results: out };
      }
      if (data.status && data.status !== "ZERO_RESULTS") {
        googleError =
          googleError ??
          `${data.status}${data.error_message ? `: ${data.error_message}` : ""}`;
      }
    } catch {
      /* fall through to OSM */
    }
  }

  // 3) OpenStreetMap Nominatim - free, real data, no key needed.
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${MAX_SUGGESTIONS}&q=${encodeURIComponent(
        q
      )}`,
      {
        headers: { "User-Agent": nominatimUA() },
        cache: "no-store",
      }
    );
    const data = (await res.json()) as any[];
    const out = data.map((r) => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      source: "osm" as const,
    }));
    // Surface the Google error only when BOTH tiers came up empty - so the owner
    // learns the key needs "Places API (New)" enabled even though OSM saved the UX.
    return { results: out, error: out.length ? undefined : googleError };
  } catch {
    return { results: [], error: googleError };
  }
}

/**
 * Reverse-geocode a lat/lng into a human place label that ENDS in the country
 * (so `currencyForRegion` and the local-language agents work). Google first,
 * OpenStreetMap Nominatim as the free fallback. Returns null on total failure
 * so callers can keep the raw coordinates. Cached for a day per rounded point.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ label: string; country?: string } | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const rlat = Math.round(lat * 1000) / 1000;
  const rlng = Math.round(lng * 1000) / 1000;
  const ck = `rev:${rlat},${rlng}`;
  const cached = cacheGet<{ label: string; country?: string }>(ck);
  if (cached) return cached;

  const key = await mapsKey();
  if (key) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${rlat},${rlng}&key=${key}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      await recordApi("geocoding");
      if (data.status === "OK" && data.results?.length) {
        // Prefer a locality-level result; fall back to the first (most precise).
        const pick =
          (data.results as any[]).find((r) =>
            r.types?.some((t: string) => ["locality", "postal_town", "administrative_area_level_2"].includes(t))
          ) ?? data.results[0];
        const country = (pick.address_components as any[])?.find((c) =>
          c.types?.includes("country")
        )?.long_name;
        const out = { label: pick.formatted_address as string, country };
        cacheSet(ck, out, 24 * 3600_000);
        return out;
      }
    } catch {
      /* fall through to OSM */
    }
  }

  // OpenStreetMap Nominatim reverse - free, real data, no key.
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${rlat}&lon=${rlng}`,
      {
        headers: { "User-Agent": "WheelDeal/1.0 (rental savings app)" },
        cache: "no-store",
      }
    );
    const data = (await res.json()) as any;
    if (data?.display_name) {
      const out = {
        label: data.display_name as string,
        country: data.address?.country as string | undefined,
      };
      cacheSet(ck, out, 24 * 3600_000);
      return out;
    }
  } catch {
    /* give up - caller keeps the raw coordinates */
  }
  return null;
}

// ---- Vendor discovery ----------------------------------------------------------

const KEYWORDS: Record<VehicleClass, string> = {
  car: "car rental",
  motorbike: "motorcycle rental",
  scooter: "scooter rental",
};

export interface VendorDiscovery {
  vendors: Vendor[] | null; // null = no key OR the search failed (see error)
  error?: string; // exact Google error when a configured key failed
}

function newPlaceToVendor(
  p: any,
  origin: { lat: number; lng: number },
  vehicleClass: VehicleClass,
  i: number
): Vendor {
  const loc = {
    lat: p.location?.latitude ?? origin.lat,
    lng: p.location?.longitude ?? origin.lng,
  };
  const photoUrls: string[] = ((p.photos as any[]) ?? [])
    .filter((ph) => ph?.name)
    .slice(0, 12) // Google returns up to ~10; show them all, not just 6.
    .map((ph) => `/api/photo?name=${encodeURIComponent(ph.name)}`);
  // Today's opening line from Google's weekday descriptions.
  const weekday: string[] = p.currentOpeningHours?.weekdayDescriptions ?? [];
  const jsDay = new Date().getDay(); // 0=Sun; Google lists Mon..Sun
  const todayHours = weekday.length === 7 ? weekday[(jsDay + 6) % 7] : undefined;
  return {
    id: p.id ?? `g${i}`,
    placeId: p.id,
    name: p.displayName?.text ?? "Rental",
    lat: loc.lat,
    lng: loc.lng,
    rating: p.rating ?? 0,
    reviews: p.userRatingCount ?? 0,
    vehicleClasses: [vehicleClass],
    fulfillment: ["in-store", "hotel-delivery"],
    whatsapp: (p.internationalPhoneNumber ?? "").trim(),
    basePricePerDay: 0,
    partner: false,
    demo: false,
    address: p.formattedAddress,
    openNow: p.currentOpeningHours?.openNow,
    todayHours,
    priceLevel: undefined,
    photoUrl: photoUrls[0],
    photoUrls,
    distanceKm: haversineKm(origin, loc),
  } satisfies Vendor;
}

export async function findRealVendors(
  origin: { lat: number; lng: number },
  radiusKm: number,
  vehicleClass: VehicleClass
): Promise<VendorDiscovery> {
  const key = await mapsKey();
  if (!key) return { vendors: null };

  // ~110m coordinate rounding + 10 min TTL: repeated searches around the same
  // stay cost ZERO extra Places requests.
  const ck = `fv:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)},${Math.round(radiusKm)},${vehicleClass}`;
  const cached = cacheGet<VendorDiscovery>(ck);
  if (cached) return cached;

  // 1) Places API (New) Text Search with a location bias circle.
  const { places, error: newError } = await newTextSearch(
    key,
    {
      textQuery: KEYWORDS[vehicleClass],
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: { latitude: origin.lat, longitude: origin.lng },
          radius: Math.min(50000, radiusKm * 1000),
        },
      },
    },
    [
      "places.id",
      "places.displayName",
      "places.location",
      "places.rating",
      "places.userRatingCount",
      "places.formattedAddress",
      "places.currentOpeningHours",
      "places.internationalPhoneNumber",
      "places.photos",
    ].join(",")
  );
  await recordApi("places_search");
  if (places) {
    const mapped = places.map((p, i) => newPlaceToVendor(p, origin, vehicleClass, i));
    // Never surface shops we cannot actually message: drop any without a usable
    // phone number. (If that would empty the list, keep them so the map/list is
    // not blank, but the card still gates "Ask for price" on a real number.)
    const reachable = mapped.filter(
      (v) => (v.whatsapp ?? "").replace(/[^\d]/g, "").length >= 7
    );
    const list = reachable.length > 0 ? reachable : mapped;
    // Tag the fastest-replying quartile (Ultra insight).
    const { fastResponderPhones } = await import("./stats");
    const fast = await fastResponderPhones();
    if (fast.size) {
      for (const v of list) {
        if (fast.has((v.whatsapp ?? "").replace(/[^\d]/g, ""))) v.fastResponder = true;
      }
    }
    // Paid placements: glowing "Recommended" cards pinned to the top.
    const { tagSponsored } = await import("./sponsored");
    await tagSponsored(list);
    const out = { vendors: list };
    cacheSet(ck, out, 10 * 60_000);
    return out;
  }

  // 2) Legacy Nearby Search (older keys).
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${origin.lat},${origin.lng}&radius=${Math.min(
        50000,
        radiusKm * 1000
      )}&keyword=${encodeURIComponent(KEYWORDS[vehicleClass])}&key=${key}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      throw new Error(
        `${data.status}${data.error_message ? `: ${data.error_message}` : ""}`
      );
    }
    return {
      vendors: ((data.results as any[]) || []).map((p, i) => {
        const loc = p.geometry?.location ?? { lat: origin.lat, lng: origin.lng };
        return {
          id: p.place_id ?? `g${i}`,
          placeId: p.place_id,
          name: p.name ?? "Rental",
          lat: loc.lat,
          lng: loc.lng,
          rating: p.rating ?? 0,
          reviews: p.user_ratings_total ?? 0,
          vehicleClasses: [vehicleClass],
          fulfillment: ["in-store", "hotel-delivery"],
          whatsapp: "", // resolved on demand via Place Details
          basePricePerDay: 0,
          partner: false,
          demo: false,
          address: p.vicinity,
          openNow: p.opening_hours?.open_now,
          priceLevel: p.price_level,
          photoUrl: p.photos?.[0]?.photo_reference
            ? `/api/photo?ref=${encodeURIComponent(p.photos[0].photo_reference)}`
            : undefined,
          distanceKm: haversineKm(origin, loc),
        } satisfies Vendor;
      }),
    };
  } catch (e) {
    const legacyError = e instanceof Error ? e.message : "network error";
    return {
      vendors: null,
      error: `Google Maps key is set but both Places APIs failed. New API: ${
        newError ?? "unknown"
      }. Legacy API: ${legacyError}. In Google Cloud Console enable "Places API (New)" (and optionally the legacy "Places API") for this key, and remove API restrictions that exclude them.`,
    };
  }
}

// ---- Place details: phone + reviews -------------------------------------------

export interface PlaceDetailsResult {
  phone?: string;
  reviews: VendorReview[];
  rating?: number;
  total?: number;
  address?: string;
  website?: string;
}

export async function placeDetails(placeId: string): Promise<PlaceDetailsResult | null> {
  const key = await mapsKey();
  if (!key) return null;

  // Details rarely change - cache 6 hours per place.
  const ck = `pd:${placeId}`;
  const cached = cacheGet<PlaceDetailsResult>(ck);
  if (cached) return cached;
  await recordApi("place_details");

  // 1) Places API (New) details.
  try {
    const res = await fetch(`${NEW_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "internationalPhoneNumber,nationalPhoneNumber,rating,userRatingCount,formattedAddress,websiteUri,reviews",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const r = await res.json();
      const out: PlaceDetailsResult = {
        phone: r.internationalPhoneNumber ?? r.nationalPhoneNumber,
        rating: r.rating,
        total: r.userRatingCount,
        address: r.formattedAddress,
        website: r.websiteUri,
        reviews: ((r.reviews as any[]) || []).map((rv) => ({
          author: rv.authorAttribution?.displayName ?? "Traveller",
          rating: rv.rating ?? 0,
          text: rv.text?.text ?? "",
          timeAgo: rv.relativePublishTimeDescription ?? "",
          timestamp: rv.publishTime ? Date.parse(rv.publishTime) : 0,
        })),
      };
      cacheSet(ck, out, 6 * 3600_000);
      return out;
    }
  } catch {
    /* try legacy */
  }

  // 2) Legacy Place Details.
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=international_phone_number,formatted_phone_number,reviews,rating,user_ratings_total,formatted_address,website&key=${key}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.status !== "OK") return null;
    const r = data.result;
    const out: PlaceDetailsResult = {
      phone: r.international_phone_number ?? r.formatted_phone_number,
      rating: r.rating,
      total: r.user_ratings_total,
      address: r.formatted_address,
      website: r.website,
      reviews: ((r.reviews as any[]) || []).map((rv) => ({
        author: rv.author_name ?? "Traveller",
        rating: rv.rating ?? 0,
        text: rv.text ?? "",
        timeAgo: rv.relative_time_description ?? "",
        timestamp: (rv.time ?? 0) * 1000,
      })),
    };
    cacheSet(ck, out, 6 * 3600_000);
    return out;
  } catch {
    return null;
  }
}

// ---- Key diagnostics (admin "Test key" button) ---------------------------------

export interface MapsDiagnostics {
  keyConfigured: boolean;
  placesNew: { ok: boolean; detail: string };
  placesLegacy: { ok: boolean; detail: string };
  geocoding: { ok: boolean; detail: string };
}

/** Run a real request against each Google API and report the exact outcome. */
export async function runMapsDiagnostics(): Promise<MapsDiagnostics> {
  const key = await mapsKey();
  if (!key) {
    const off = { ok: false, detail: "No key configured." };
    return { keyConfigured: false, placesNew: off, placesLegacy: off, geocoding: off };
  }

  const probe = { lat: -8.6478, lng: 115.1385 }; // Canggu, Bali

  const [n, l, g] = await Promise.all([
    (async () => {
      const { places, error } = await newTextSearch(
        key,
        {
          textQuery: "scooter rental",
          maxResultCount: 1,
          locationBias: {
            circle: { center: { latitude: probe.lat, longitude: probe.lng }, radius: 10000 },
          },
        },
        "places.id,places.displayName"
      );
      return places
        ? { ok: true, detail: `OK - found ${places.length} result(s).` }
        : { ok: false, detail: error ?? "failed" };
    })(),
    (async () => {
      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${probe.lat},${probe.lng}&radius=10000&keyword=scooter%20rental&key=${key}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        return data.status === "OK" || data.status === "ZERO_RESULTS"
          ? { ok: true, detail: `OK (${data.status}).` }
          : { ok: false, detail: `${data.status}${data.error_message ? `: ${data.error_message}` : ""}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
    })(),
    (async () => {
      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=Canggu%20Bali&key=${key}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        return data.status === "OK"
          ? { ok: true, detail: "OK." }
          : { ok: false, detail: `${data.status}${data.error_message ? `: ${data.error_message}` : ""}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
    })(),
  ]);

  return { keyConfigured: true, placesNew: n, placesLegacy: l, geocoding: g };
}
