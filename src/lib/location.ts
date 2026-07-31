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
  // NO CONSENT -> NO LINK OF ANY KIND. The M5 leak contract, unchanged.
  if (!stay?.shareConsent) return out;
  // CONSENT, BUT NO USABLE PIN -> a link to the PLACE BY NAME.
  //
  // The only builder here was coordinate-based, so a consented share with no
  // stored coordinates (every one-off "meet me at this cafe", where the
  // traveller picks a place for THIS share and no position is stored) sent the
  // shop a bare name to retype into their own maps app - the exact friction
  // the delivery flow exists to remove. A search-by-name URL is a different
  // privacy object from a pin: it says "this named place", not "this person is
  // at these coordinates". It carries nothing the address text does not.
  if (!validLat(stay.lat) || !validLng(stay.lng)) {
    out.mapsLink = placeMapsLink(label);
    return out;
  }
  out.coords = { lat: stay.lat, lng: stay.lng };
  out.mapsLink = `https://maps.google.com/?q=${stay.lat.toFixed(6)},${stay.lng.toFixed(6)}`;
  return out;
}

/**
 * A MAPS LINK FOR A PLACE, WITHOUT EXPOSING A POSITION.
 *
 * The only link builder here was coordinate-based and consent-gated, so a
 * one-off share ("meet me at this cafe") could never carry a link at all -
 * the shop got a bare name to type into their own maps app, which is exactly
 * the friction the delivery flow exists to remove.
 *
 * A place-name search URL is a different privacy object from a pin: it says
 * "this named place", not "this person is at these coordinates to six
 * decimals". It needs no consent gate because it discloses nothing the
 * address text does not already say - and the traveller chose the place.
 *
 * Server-composed only; the query is the Google-resolved label, never a
 * string a client handed us.
 */
export function placeMapsLink(label: string | null | undefined): string | undefined {
  const q = (label ?? "").trim();
  if (q.length < 3) return undefined;
  // A label that already IS a link is never re-wrapped (nothing downstream
  // should be able to smuggle a URL through the address field).
  if (/https?:\/\//i.test(q)) return undefined;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
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
