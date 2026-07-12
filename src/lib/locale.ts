// Single source of truth for "how do we talk to shops in THIS country" - the
// English register (simple vs formal) and the low-English currency set. Region
// -> currency itself still lives in agents.ts (currencyForRegion), but the
// English-level decision is centralised here so it can key on COUNTRY, not just
// currency. That fixes places like Cambodia, where shops quote USD (so a
// currency-only rule never fired) yet English is very much a second language.

// Countries where plain, simple English (or the local language for Ultra) lands
// far better than formal English. Matched against the country segment of a
// geocoded region label. Lowercase, no punctuation.
const LOW_ENGLISH_COUNTRIES = new Set([
  "thailand", "indonesia", "vietnam", "viet nam", "cambodia", "laos", "lao pdr",
  "myanmar", "burma", "philippines", "india", "sri lanka", "nepal", "bangladesh",
  "pakistan", "china", "taiwan", "japan", "south korea", "korea", "mongolia",
  "malaysia", "morocco", "egypt", "tunisia", "algeria", "kenya", "tanzania",
  "ethiopia", "uganda", "ghana", "nigeria", "senegal", "turkey", "türkiye",
  "turkiye", "georgia", "armenia", "azerbaijan", "uzbekistan", "kazakhstan",
  "mexico", "guatemala", "honduras", "nicaragua", "el salvador", "costa rica",
  "panama", "colombia", "peru", "bolivia", "ecuador", "brazil", "brasil",
  "paraguay", "venezuela", "dominican republic", "russia", "ukraine",
]);

// Low-English CURRENCY fallback (used when we know the currency but not the
// exact country label). Kept here so the register logic has one home.
export const LOW_ENGLISH_CURRENCIES = new Set([
  "THB", "IDR", "VND", "PHP", "INR", "LKR", "NPR", "MYR", "LAK", "KHR",
  "MAD", "EGP", "KES", "TRY", "MXN", "COP", "PEN", "BRL", "MMK", "BDT",
  "PKR", "UAH", "RUB", "GEL", "UZS", "KZT",
]);

/** Extract the lowercase country segment from a geocoded region label. */
export function countryFromRegion(region?: string): string | undefined {
  if (!region) return undefined;
  const parts = region
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
}

/**
 * True when this region (or currency) is a place where simple, low-level
 * English is the right register. Country wins; currency is the fallback.
 */
export function isLowEnglish(region?: string, currency?: string): boolean {
  const country = countryFromRegion(region);
  if (country && LOW_ENGLISH_COUNTRIES.has(country)) return true;
  // Some labels are just a country name with no comma - test the whole thing.
  if (region && LOW_ENGLISH_COUNTRIES.has(region.trim().toLowerCase())) return true;
  return Boolean(currency && LOW_ENGLISH_CURRENCIES.has(currency.toUpperCase()));
}
