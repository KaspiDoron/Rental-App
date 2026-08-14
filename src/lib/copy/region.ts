// Region resolution for opener copy (pure). The bug this fixes: region came
// from the origin/stay LABEL (a Google Places hotel string), never from the
// shop's phone country - so a Filipino sign-off ("Salamat!") reached a +84
// Vietnam shop, and Vietnamese "cam on" was glued onto the greeting. Here the
// SHOP's phone country prefix decides the region; the label is only a fallback.

export type ShopRegion = "philippines" | "thailand" | "vietnam" | "indonesia";

// Country calling code -> region. Only the SE-Asia markets we localise for.
const PREFIX_REGION: { prefix: string; region: ShopRegion }[] = [
  { prefix: "63", region: "philippines" },
  { prefix: "66", region: "thailand" },
  { prefix: "84", region: "vietnam" },
  { prefix: "62", region: "indonesia" },
];

/** The region implied by a shop's phone number (digits, with or without +).
 * Returns null for anything outside the localised markets. */
export function regionFromPhone(phoneOrDigits: string): ShopRegion | null {
  const digits = (phoneOrDigits || "").replace(/\D/g, "").replace(/^0+/, "");
  for (const { prefix, region } of PREFIX_REGION) {
    if (digits.startsWith(prefix)) return region;
  }
  return null;
}

/** The region key for a shop: the phone country WINS (authoritative), falling
 * back to a country name found in the origin/stay label. Undefined when neither
 * resolves - the compiler then uses neutral English (no regional flavor). */
export function regionForShop(shopDigits: string, fallbackLabel?: string): ShopRegion | undefined {
  const byPhone = regionFromPhone(shopDigits);
  if (byPhone) return byPhone;
  const label = (fallbackLabel ?? "").toLowerCase();
  const named = (["philippines", "thailand", "vietnam", "indonesia"] as ShopRegion[]).find((r) =>
    label.includes(r)
  );
  return named;
}

// ---------------------------------------------------------------------------
// COUNTRY resolution - the LANGUAGE decision (owner report 4, item 8).
//
// `regionForShop` above answers a narrow question - "which SE-Asia greeting
// flavor?" - and it was also the only thing feeding localizeMessage's region,
// so "bargain in the local language" silently worked in exactly four
// countries. A +52 Mexico shop got fluent English with a `localize-fallback`
// event blaming "AI localization unavailable", which was false: the AI was
// never asked.
//
// This table answers the question the language feature actually has: WHICH
// COUNTRY is this phone number in. The name feeds localizeMessage verbatim
// ("the everyday local language of Mexico"), and locale.ts's
// isEnglishSpeaking() already short-circuits the English-speaking entries -
// so covering the whole map costs nothing where English is the answer.
// ---------------------------------------------------------------------------

// Calling code -> country name. Longest prefix wins at match time. The names
// line up with locale.ts's lists (lowercased there) - keep them in step.
const PREFIX_COUNTRY: Record<string, string> = {
  // North America (shared +1 - the English-speaking default is right for both)
  "1": "United States",
  // Africa + MENA
  "20": "Egypt", "212": "Morocco", "213": "Algeria", "216": "Tunisia",
  "221": "Senegal", "233": "Ghana", "234": "Nigeria", "251": "Ethiopia",
  "254": "Kenya", "255": "Tanzania", "256": "Uganda", "27": "South Africa",
  // Europe
  "30": "Greece", "31": "Netherlands", "32": "Belgium", "33": "France",
  "34": "Spain", "351": "Portugal", "354": "Iceland", "357": "Cyprus",
  "358": "Finland", "359": "Bulgaria", "36": "Hungary", "370": "Lithuania",
  "371": "Latvia", "372": "Estonia", "380": "Ukraine", "385": "Croatia",
  "386": "Slovenia", "389": "North Macedonia", "381": "Serbia", "382": "Montenegro",
  "355": "Albania", "39": "Italy", "40": "Romania", "41": "Switzerland",
  "420": "Czech Republic", "421": "Slovakia", "43": "Austria", "44": "United Kingdom",
  "45": "Denmark", "46": "Sweden", "47": "Norway", "48": "Poland", "49": "Germany",
  "353": "Ireland", "356": "Malta", "7": "Russia",
  // Latin America + Caribbean
  "51": "Peru", "52": "Mexico", "53": "Cuba", "54": "Argentina", "55": "Brazil",
  "56": "Chile", "57": "Colombia", "58": "Venezuela", "502": "Guatemala",
  "503": "El Salvador", "504": "Honduras", "505": "Nicaragua", "506": "Costa Rica",
  "507": "Panama", "591": "Bolivia", "593": "Ecuador", "595": "Paraguay",
  "598": "Uruguay",
  // Middle East + Caucasus + Central Asia
  "90": "Turkey", "961": "Lebanon", "962": "Jordan", "965": "Kuwait",
  "966": "Saudi Arabia", "968": "Oman", "971": "United Arab Emirates",
  "972": "Israel", "973": "Bahrain", "974": "Qatar", "994": "Azerbaijan",
  "995": "Georgia", "374": "Armenia", "998": "Uzbekistan",
  // South Asia
  "91": "India", "92": "Pakistan", "94": "Sri Lanka", "880": "Bangladesh",
  "977": "Nepal",
  // Southeast + East Asia
  "60": "Malaysia", "62": "Indonesia", "63": "Philippines", "65": "Singapore",
  "66": "Thailand", "84": "Vietnam", "855": "Cambodia", "856": "Laos",
  "95": "Myanmar", "81": "Japan", "82": "South Korea", "86": "China",
  "886": "Taiwan", "976": "Mongolia",
  // Oceania
  "61": "Australia", "64": "New Zealand",
};

/**
 * The COUNTRY a shop's phone number is in, for the language decision.
 *
 * Longest-prefix match on the calling code; the label (a geocoded region
 * string like "Tulum, Mexico") is only the fallback when the number resolves
 * nowhere. Returns undefined when neither answers - localizeMessage then
 * declines with the honest "no-region" reason instead of a false AI blame.
 */
export function countryForShop(shopDigits: string, fallbackLabel?: string): string | undefined {
  const digits = (shopDigits || "").replace(/\D/g, "").replace(/^0+/, "");
  for (const len of [3, 2, 1]) {
    const hit = PREFIX_COUNTRY[digits.slice(0, len)];
    if (hit) return hit;
  }
  const label = (fallbackLabel ?? "").trim();
  return label || undefined;
}
