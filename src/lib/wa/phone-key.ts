// THE canonical WhatsApp routing key + tolerant thread matching.
//
// Two independent formats reach us for the same shop:
//   - WhatsApp/Evolution deliver a JID user-part: "639661952196", and on
//     multi-device "639661952196:12@s.whatsapp.net" (a DEVICE suffix).
//   - Google Places sometimes only exposes the NATIONAL number
//     ("0966 195 2196"), which we stored as "09661952196".
// Every thread lookup is an exact `to_number=eq.<digits>` match, so those two
// spellings of one shop never meet: the outbound anchor is invisible to the
// inbound reply and the agent goes silent. `waDigits` produces one canonical
// key at every write; `numberVariants` lets a read still find rows written in
// any legacy spelling, so existing threads heal with no migration.

import { digitsOnly } from "../phone";

// Country calling codes for the markets we operate in, longest-first so "63"
// can never shadow a longer code added later.
const CALLING_CODES = ["63", "66", "84", "62", "60", "65", "91", "44", "61", "1"];

/**
 * Canonical routing key: strip any JID host, drop the multi-device suffix
 * (":12"), then digits only. "639661952196:12@s.whatsapp.net" -> "639661952196".
 */
export function waDigits(input: string | null | undefined): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const userPart = s.includes("@") ? s.split("@")[0] : s;
  const noDevice = userPart.split(":")[0];
  return digitsOnly(noDevice);
}

/**
 * Every spelling this shop's number may already be stored under, newest
 * convention first. Used to build a tolerant `or=(...)` read filter so a thread
 * written before canonicalization is still found.
 *
 * "639661952196" -> ["639661952196", "09661952196", "9661952196"]
 * "09661952196"  -> ["09661952196", "9661952196", "639661952196"]  (cc unknown -> skipped)
 */
export function numberVariants(input: string | null | undefined, defaultCc?: string): string[] {
  const canonical = waDigits(input);
  if (!canonical) return [];
  const out = new Set<string>([canonical]);

  // International -> national forms (drop the country code, with/without the
  // national trunk "0").
  for (const cc of CALLING_CODES) {
    if (canonical.length > cc.length + 6 && canonical.startsWith(cc)) {
      const national = canonical.slice(cc.length);
      out.add(national);
      out.add(`0${national}`);
      break;
    }
  }

  // National -> international, when we know which country to assume.
  const cc = digitsOnly(defaultCc);
  if (cc) {
    const bare = canonical.replace(/^0+/, "");
    if (!canonical.startsWith(cc)) out.add(`${cc}${bare}`);
  }
  if (canonical.startsWith("0")) out.add(canonical.replace(/^0+/, ""));

  return [...out].filter(Boolean);
}

/**
 * A PostgREST `or=(...)` value matching `column` against every known spelling.
 * Returns null when there is nothing to match (caller should skip the query).
 * Passed as a SEPARATE query param: `&or=${threadNumberOr("to_number", d)}`.
 */
export function threadNumberOr(column: string, input: string, defaultCc?: string): string | null {
  const variants = numberVariants(input, defaultCc);
  if (variants.length === 0) return null;
  // PostgREST values here are bare digits (no commas/parens possible), so this
  // cannot break the or() grammar - but stay strict anyway.
  const safe = variants.filter((v) => /^\d{5,20}$/.test(v));
  if (safe.length === 0) return null;
  return `(${safe.map((v) => `${column}.eq.${v}`).join(",")})`;
}

/** Do two numbers denote the same shop, allowing legacy spellings? */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const av = new Set(numberVariants(a));
  if (av.size === 0) return false;
  return numberVariants(b).some((v) => av.has(v));
}
