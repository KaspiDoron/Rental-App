// Pure inbound-intent detectors (no server-only) so they are unit-testable and
// shared across the engine + legacy loop.

/**
 * Did the shop ask WHERE the traveller is staying (to arrange delivery)? Shops
 * routinely drop the "?" ("Where did you stay sir", "send me your hotel
 * location"), so this catches the location ask specifically - WITHOUT matching
 * "where are you FROM" (small talk, not a delivery-address request).
 */
export function shopAskedLocation(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  if (/\bwhere\s+(are|r)\s+you\s+from\b/.test(t)) return false;
  return (
    /\bwhere\s+(did|do|are|is|r|u)\b[^?.!]{0,24}\b(stay|staying|located|hotel|now)\b/.test(t) ||
    /\b(your|the)\s+(hotel|accommodation|location|address)\b/.test(t) ||
    /\bwhere\s+(is|are)\s+(you|u|your)\b[^?.!]{0,16}\b(hotel|stay|location)\b/.test(t) ||
    /\b(send|share|drop)\b[^?.!]{0,20}\b(location|hotel|address|pin)\b/.test(t) ||
    /\bwhere\s+(did|do)\s+(you|u)\s+stay\b/.test(t)
  );
}
