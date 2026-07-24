// Inbound location handling (Module 4.2).
//
// A rental shop often replies with a WhatsApp location PIN or a pasted Google
// Maps link. Previously the pin's coordinates were dropped into a bare text
// string and never used. This module (a) parses coordinates from BOTH a pin and
// inbound text (maps link / ?q= / @lat,lng / bare "lat, lng"), and (b) when the
// traveller has SHARED their stay location (consent-gated via getUserStay),
// computes the distance to their stay so the agent can reason about delivery
// feasibility - e.g. "you're about 2.3 km from my hotel, can you deliver?".
//
// Privacy: we only ever surface a ROUGH distance (never the traveller's pin),
// and only when they consented to share their location; getUserStay already
// masks the coordinates without consent.

import "server-only";
import { haversineKm } from "../geo";

const inRange = (n: number, max: number) => Number.isFinite(n) && Math.abs(n) <= max;

/** Extract {lat,lng} from inbound TEXT: a Google Maps link, `?q=lat,lng`,
 *  `@lat,lng`, or a bare "lat, lng" pair. null when none is plausible. */
export function parseInboundCoords(text: string): { lat: number; lng: number } | null {
  if (!text) return null;
  const m =
    text.match(/[?&]q=(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/) ||
    text.match(/@(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/) ||
    text.match(/(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!inRange(lat, 90) || !inRange(lng, 180)) return null;
  return { lat, lng };
}

export interface StayCoords {
  lat?: number;
  lng?: number;
}

/** A short, human distance string, or "" when the stay coords are unknown. */
export function distanceNote(
  loc: { lat: number; lng: number },
  stay?: StayCoords | null
): string {
  if (!stay || !Number.isFinite(stay.lat) || !Number.isFinite(stay.lng)) return "";
  const km = haversineKm(loc, { lat: stay.lat as number, lng: stay.lng as number });
  if (!Number.isFinite(km)) return "";
  const pretty = km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
  const feasible = km <= 5 ? " (close - delivery is realistic)" : km <= 15 ? " (a moderate delivery distance)" : " (far - delivery may cost extra or not be offered)";
  return ` - about ${pretty} from the traveller's stay${feasible}`;
}

/** Build the enriched synthetic text for a shop-shared location pin, including
 *  the distance-to-stay note when available. */
export function describeShopLocation(
  loc: { lat: number; lng: number; name?: string },
  stay?: StayCoords | null
): string {
  const namePart = loc.name ? `: ${loc.name}` : "";
  return `(the shop shared its location${namePart}${distanceNote(loc, stay)} - https://maps.google.com/?q=${loc.lat},${loc.lng})`;
}
