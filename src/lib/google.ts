// Google Maps Platform integration (server-side only - the key never reaches
// the browser; all calls are proxied through our API routes).
//
// With GOOGLE_MAPS_API_KEY configured:
//   - address autocomplete/geocoding uses Google Geocoding
//   - vendor discovery uses Places Nearby Search (real rental businesses)
//   - reviews come from Place Details (real Google reviews)
//   - photos stream through /api/photo
// Without it, geocoding falls back to OpenStreetMap Nominatim (free, real
// data), and vendors fall back to clearly-labelled demo seeds.

import "server-only";
import { getConfig } from "./runtime-config";
import { haversineKm } from "./geo";
import type { Vendor, VehicleClass, VendorReview } from "./types";

export async function mapsKey(): Promise<string | undefined> {
  return getConfig("GOOGLE_MAPS_API_KEY");
}

// ---- Geocoding / address search ---------------------------------------------

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
  source: "google" | "osm";
}

export async function searchPlaces(q: string): Promise<PlaceSuggestion[]> {
  const key = await mapsKey();
  if (key) {
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
          q
        )}&key=${key}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data.status === "OK") {
        return (data.results as any[]).slice(0, 6).map((r) => ({
          label: r.formatted_address,
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          source: "google" as const,
        }));
      }
    } catch {
      /* fall through to OSM */
    }
  }
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(
        q
      )}`,
      {
        headers: { "User-Agent": "WheelDeal/1.0 (rental savings app)" },
        cache: "no-store",
      }
    );
    const data = (await res.json()) as any[];
    return data.map((r) => ({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      source: "osm" as const,
    }));
  } catch {
    return [];
  }
}

// ---- Vendor discovery (Places Nearby Search) ----------------------------------

const KEYWORDS: Record<VehicleClass, string> = {
  car: "car rental",
  motorbike: "motorcycle rental",
  scooter: "scooter rental",
};

export async function findRealVendors(
  origin: { lat: number; lng: number },
  radiusKm: number,
  vehicleClass: VehicleClass
): Promise<Vendor[] | null> {
  const key = await mapsKey();
  if (!key) return null;

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
      throw new Error(data.status);
    }
    return ((data.results as any[]) || []).map((p, i) => {
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
    });
  } catch {
    return null; // caller decides on fallback
  }
}

// ---- Place details: phone + reviews -------------------------------------------

export async function placeDetails(placeId: string): Promise<{
  phone?: string;
  reviews: VendorReview[];
  rating?: number;
  total?: number;
  address?: string;
  website?: string;
} | null> {
  const key = await mapsKey();
  if (!key) return null;
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=international_phone_number,formatted_phone_number,reviews,rating,user_ratings_total,formatted_address,website&key=${key}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data.status !== "OK") return null;
    const r = data.result;
    return {
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
  } catch {
    return null;
  }
}
