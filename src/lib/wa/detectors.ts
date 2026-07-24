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

/**
 * Did the shop ask whether the traveller HAS a (international) driving license?
 * Common phrasings + typos seen live: "do you have an international driving
 * liscense ?", "u have license?", "IDP?", "got a driver license for big bike?".
 * A PHOTO/copy request (shopAskedLicensePhoto) is the stricter match and is
 * checked first by callers - this one covers the yes/no availability question.
 */
export function shopAskedLicense(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  // Any license-ish token (license/licence + the live typos liscense/lisence,
  // driving permit, IDP).
  const licenseToken =
    /\b(licen[cs]e|li[cs][cs]?en[cs]e|driving\s+permit|driver'?s?\s+permit|idp)\b/;
  if (!licenseToken.test(t)) return false;
  return (
    // "do you have / got / u have ... license"
    /\b(do\s+)?(you|u)\s+(have|got|hold|carry)\b[^?.!]{0,40}(licen[cs]e|li[cs][cs]?en[cs]e|permit|idp)/.test(t) ||
    // "have/got a license?" / "license?" style shorthand
    /\b(have|got|with)\s+(a\s+|an\s+)?(international\s+)?(driv(er'?s?|ing)\s+)?(licen[cs]e|li[cs][cs]?en[cs]e|idp)\b/.test(t) ||
    /\b(licen[cs]e|li[cs][cs]?en[cs]e|idp)\s*\?/.test(t)
  );
}

/**
 * Did the shop ask to SEE the license (photo / copy / picture / send it) - as
 * opposed to just asking whether the traveller has one? Per policy the agent
 * defers sharing any document until the rate and rental details are agreed.
 */
export function shopAskedLicensePhoto(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  return (
    /\b(send|share|show|see|photo|picture|pic|copy|scan|foto)\b[^?.!]{0,40}\b(licen[cs]e|li[cs][cs]?en[cs]e|idp|driving\s+permit)\b/.test(t) ||
    /\b(licen[cs]e|li[cs][cs]?en[cs]e|idp)\b[^?.!]{0,30}\b(photo|picture|pic|copy|scan|foto)\b/.test(t)
  );
}

/**
 * Did the shop ask whether the traveller IS IN a place ("Are you there in
 * moalboal, cebu?", "you here in Boracay?")? A REGION-context question, not a
 * delivery-address request - answered from the search region STRING only
 * (Module 5 D3: never coordinates, never the stay). Location asks
 * (shopAskedLocation) take priority and are deliberately excluded.
 */
export function shopAskedPresence(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  if (shopAskedLocation(t)) return false; // delivery-address asks win
  if (/\bwhere\s+(are|r)\s+you\s+from\b/.test(t)) return false;
  return (
    // "are you (there|here|now) in <place>" - typos like "are you there in
    // moalboal, cebu,v" included; the trailing place is required.
    /\b(are|r)\s+(you|u)\s+(there|here|now|already|still)?\s*(in|at|near)\s+[a-z]/.test(t) ||
    // "you in <place>?" / "you here?" style shorthand with a question mark.
    /\b(you|u)\s+(in|at|near)\s+[a-z][^?]{0,30}\?/.test(t) ||
    /\b(are|r)\s+(you|u)\s+(here|there|around|nearby)\s*\?/.test(t)
  );
}
