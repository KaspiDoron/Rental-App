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
    // A "where ... stay/hotel/located" question (the "?" often dropped).
    /\bwhere\s+(did|do|are|is|r|u)\b[^?.!]{0,24}\b(stay|staying|located|hotel|now)\b/.test(t) ||
    // An interrogative "where/what is your hotel/address/location" - requires the
    // where/what lead so a DECLARATIVE "deliver to the hotel is 50k" / "the
    // address is ..." / "we deliver to your hotel" never triggers it.
    /\b(where|what)('?s| is| are)?\s+(your|the)\s+(hotel|accommodation|location|address)\b/.test(t) ||
    // A bare "your hotel?" style ask (must END on the noun + a question mark).
    /\b(your|the)\s+(hotel|accommodation|location|address)\s*\?/.test(t) ||
    // An explicit request to send/share the location.
    /\b(send|share|drop)\b[^?.!]{0,20}\b(location|hotel|address|pin)\b/.test(t)
  );
}
