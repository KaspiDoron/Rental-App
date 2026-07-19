// LOCATION PRIVACY GATE (Module 5) - the ONE place that decides what location
// information may ever leave the system toward a rental shop.
//
// Production incident: the pickup-consent path sent a shop a raw
// maps.google.com/?q=<lat>,<lng> pin built from CLIENT-POSTED coordinates -
// stale device GPS from a previous trip (a Gulf-of-Thailand pin during a Cebu
// search). The rule, enforced here and nowhere else:
//
//   - ADDRESS TEXT (the typed hotel/street label) is the default and the only
//     thing shared without explicit precise-location consent.
//   - COORDINATES exist in an outbound message ONLY when the user flipped the
//     "Share precise location" toggle (stayShareConsentAt server-side) AND the
//     stored coordinates are sane. Client-posted lat/lng are NEVER consumed.
//
// Pure: no IO, no server-only - unit-tested, imported by the engine nodes,
// the API routes and (read-only) the UI copy.

export interface UserStayLike {
  label?: string | null;
  lat?: number | null;
  lng?: number | null;
  shareConsent?: boolean;
}

export interface ShareableLocation {
  /** The typed hotel/street text - shareable whenever present. */
  addressText: string | null;
  /** Present ONLY with explicit consent + valid stored coordinates. */
  coords?: { lat: number; lng: number };
  /** The maps pin derived from coords - same consent gate. */
  mapsLink?: string;
}

function validLat(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= -90 && n <= 90 && n !== 0;
}
function validLng(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= -180 && n <= 180 && n !== 0;
}

/**
 * Resolve what the agent MAY share for this traveller. The single gate:
 * every share path (pickup, delivery-answer, anything future) composes from
 * this result and only this result.
 */
export function resolveShareableLocation(stay: UserStayLike | null | undefined): ShareableLocation {
  const label = (stay?.label ?? "").trim();
  const out: ShareableLocation = { addressText: label || null };
  if (!stay?.shareConsent) return out; // no consent -> text only, always
  if (!validLat(stay.lat) || !validLng(stay.lng)) return out; // junk coords -> text only
  out.coords = { lat: stay.lat, lng: stay.lng };
  out.mapsLink = `https://maps.google.com/?q=${stay.lat.toFixed(6)},${stay.lng.toFixed(6)}`;
  return out;
}

export interface StayInput {
  label: string;
  shareConsent: boolean;
  lat?: number;
  lng?: number;
}

/**
 * Sanitize a client-posted stay BEFORE it reaches storage. The hard rule the
 * owner mandated: coordinates are STRIPPED unless shareConsent === true - a
 * tampered client cannot smuggle coords in with consent off, and out-of-range
 * values never persist. Returns null when there is nothing valid to store.
 */
export function sanitizeStayInput(body: unknown): StayInput | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const label = String(b.label ?? "").trim().slice(0, 160);
  if (!label) return null;
  const shareConsent = b.shareConsent === true;
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (shareConsent && validLat(lat) && validLng(lng)) {
    return { label, shareConsent, lat, lng };
  }
  // Consent off (or coords invalid): the label persists, coords NEVER do.
  return { label, shareConsent };
}
