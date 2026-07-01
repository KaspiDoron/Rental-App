// Geospatial helpers.

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two coordinates, in kilometres. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Deterministically scatter a point within a radius — used to seed demo vendors. */
export function scatter(
  origin: { lat: number; lng: number },
  seed: number,
  maxKm: number
): { lat: number; lng: number } {
  const angle = (seed * 137.508 * Math.PI) / 180; // golden-angle spread
  const dist = ((seed % 7) / 7) * maxKm + 0.3;
  const dLat = (dist / 111) * Math.cos(angle);
  const dLng =
    (dist / (111 * Math.cos(toRad(origin.lat)) || 1)) * Math.sin(angle);
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}
