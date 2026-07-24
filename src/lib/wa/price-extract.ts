// Human-grade deterministic rental-price extraction.
//
// Shops rarely reply with a clean "350/day". They send a whole business
// template mixing services - airport/port transfers ("250 PHP/trip"), island
// tours, shuttle - with the actual vehicle rental line buried inside:
//
//   Welcome to Sun House Rental! ...
//   Airport <-> Sun House Rental: 250 PHP/trip
//   Balbagon Port <-> Sun House Rental: 350 PHP/trip
//   Benoni Port <-> Sun House Rental: 600 PHP/trip
//   Scooter: 350 PHP/day
//   Island tour available
//
// The rigid old regex missed this on two counts: it assumed the currency comes
// BEFORE the number ("PHP 350") so "350 PHP/day" never matched, and it had no
// notion of ignoring transfer/tour noise (so a "/trip" price could be grabbed).
//
// This reads the message LINE BY LINE like a person would: drop the transfer /
// tour / service lines, keep only genuine per-day rental lines, prefer the line
// that names the requested vehicle class, and return the cheapest matching
// daily rate. Pure + fully unit-tested; used as the deterministic fallback AND
// as a backstop that rescues a price the LLM missed.

export type VehicleClassHint = "car" | "motorbike" | "scooter" | undefined;

export interface RentalPriceHit {
  pricePerDay: number;
  currency?: string;
  line: string;
  // true  = the line names the SAME class the traveller asked for
  // false = the line names a DIFFERENT class (car vs scooter)
  // undefined = the line names no class (a bare "350/day")
  classMatch?: boolean;
}

// Currency CODES/symbols AND the spoken WORDS shops actually type ("400 baht
// per day", "4000 baht per month") - the word forms were missing, which made
// every "<n> baht ..." quote invisible to the day/month/week patterns (a live
// dropped-offer class).
const CUR =
  "[$€฿₱₹₫]|(?:usd|idr|rp|eur|thb|rm|php|inr|vnd|myr|aud|nzd|sgd|mxn|try|ils|zar|brl|mad|egp|lkr|npr|twd|jpy|krw)" +
  "|(?:baht|pesos?|piso|rupiah|rupees?|dong|ringgit|dollars?|euros?|shekels?|dirhams?)";

// A money amount: either grouped thousands ("1,750" / "1.750" / "1 750") OR a
// plain run of digits ("1750", "350"), optional decimals. The old pattern only
// matched the grouped form, so a bare "1750" was truncated to "175".
const NUM = "(\\d{1,3}(?:[.,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

// A currency token in EITHER position around the number, and a per-day marker.
const PRICE_DAY = new RegExp(
  `(?:${CUR})?\\s*${NUM}\\s*(?:${CUR})?\\s*(?:[-/]|per\\s*|a\\s+)?\\s*(?:day|d\\b|24\\s*h(?:rs?|ours?)?|/\\s*24)`,
  "i"
);
// A total for the whole rental ("1750 in 5 days", "900 for 3 days") - divided.
const PRICE_TOTAL = new RegExp(
  `(?:${CUR})?\\s*${NUM}\\s*(?:${CUR})?\\s*(?:for|in|=|:)?\\s*(\\d{1,2})\\s*days?\\b`,
  "i"
);
// The day count BEFORE the total ("3 days 900", "5 days is 1750") - also divided.
const PRICE_TOTAL_REV = new RegExp(
  `\\b(\\d{1,2})\\s*days?\\b[^\\d]{0,10}(?:${CUR})?\\s*${NUM}`,
  "i"
);
// A MONTHLY quote ("4000 per month", "4000/month", "monthly 4000") - the format
// long-rental shops actually use, which the day-only patterns silently dropped
// (the live "3 of 4 offers vanished" failure on a 30-day search).
const PRICE_MONTH = new RegExp(
  `(?:${CUR})?\\s*${NUM}\\s*(?:${CUR})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*month|month(?:ly)?\\s*(?:rate|price|rental)?\\s*(?:is|:|=)?\\s*(?:${CUR})?\\s*${NUM}`,
  "i"
);
// A WEEKLY quote ("1500 a week", "weekly 1500").
const PRICE_WEEK = new RegExp(
  `(?:${CUR})?\\s*${NUM}\\s*(?:${CUR})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*week|week(?:ly)?\\s*(?:rate|price)?\\s*(?:is|:|=)?\\s*(?:${CUR})?\\s*${NUM}`,
  "i"
);
// A BARE price answer: the whole (short) message is just an amount + optional
// currency ("400", "400 baht", "PHP 350 only") - the natural reply to "what's
// your best price per day?". Strict shape so times/phone numbers never match.
const BARE_PRICE = new RegExp(
  `^\\s*(?:${CUR})?\\s*${NUM}\\s*(?:${CUR}|baht|pesos?|peso|dollars?|rupiah|dong|ringgit)?\\s*(?:only|net|\\.|!)?\\s*$`,
  "i"
);

/** Normalize k-notation ("150k", "1.5k") into full numbers before matching. */
function expandK(line: string): string {
  return line.replace(/(\d+(?:\.\d+)?)\s*k\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1000)));
}

// A line that is a transfer / tour / other service, NOT a vehicle rental.
const SERVICE_LINE =
  /\b(trip|transfer|shuttle|airport|port|pier|ferry|terminal|tour|drop\s?off service|pick\s?up service|boat|van service|habal)\b|↔|⇄|<->|<=>|<\s*-\s*>/i;

const SCOOTER_WORDS = /\b(scooter|scoopy|click|fino|filano|nmax|pcx|vespa|beat|mio|aerox|vario|moped|automatic)\b/i;
const MOTORBIKE_WORDS = /\b(motor\s?bike|motorcycle|manual|semi\s?auto|sportbike|dirt\s?bike|xr|klx|crf|raider|sniper)\b/i;
const CAR_WORDS = /\b(car|sedan|suv|hatchback|van|mpv|pickup|4x4|jeep|multicab)\b/i;

function lineClass(line: string): VehicleClassHint {
  // Car words win only when no 2-wheel word is present (a "car rental" shop line
  // that also lists a scooter must still classify the scooter line correctly).
  if (SCOOTER_WORDS.test(line)) return "scooter";
  if (MOTORBIKE_WORDS.test(line)) return "motorbike";
  if (CAR_WORDS.test(line)) return "car";
  return undefined;
}

function parseAmount(raw: string): number {
  // Strip thousands separators (",", ".", spaces) leaving one number.
  const cleaned = raw.replace(/[,\s]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  return parseFloat(cleaned);
}

function currencyIn(line: string): string | undefined {
  const m = line.match(new RegExp(CUR, "i"));
  if (!m) return undefined;
  const t = m[0].toLowerCase();
  if (/\$|usd|dollar/.test(t)) return "USD";
  if (/€|eur/.test(t)) return "EUR";
  if (/฿|thb|baht/.test(t)) return "THB";
  if (/₱|php|peso|piso/.test(t)) return "PHP";
  if (/₹|inr|rupee/.test(t)) return "INR";
  if (/₫|vnd|dong/.test(t)) return "VND";
  if (/\brp\b|idr|rupiah/.test(t)) return "IDR";
  if (/\brm\b|myr|ringgit/.test(t)) return "MYR";
  if (/ils|shekel/.test(t)) return "ILS";
  if (/dirham/.test(t)) return "AED";
  return t.toUpperCase();
}

/**
 * Extract the traveller's rental DAILY price from a messy multi-line reply.
 * Returns null when no genuine per-day rental price is present (a transfer-only
 * template, or a pure greeting) so the caller can clarify.
 */
export function extractRentalDailyPrice(
  text: string,
  opts: { vehicleClass?: VehicleClassHint; durationDays?: number; localCurrency?: string } = {}
): RentalPriceHit | null {
  if (!text || !text.trim()) return null;
  const wantClass = opts.vehicleClass;
  const days = opts.durationDays && opts.durationDays > 0 ? opts.durationDays : 1;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const hits: RentalPriceHit[] = [];
  for (const rawLine of lines) {
    if (SERVICE_LINE.test(rawLine)) continue; // transfer / tour / shuttle - skip
    const line = expandK(rawLine);
    const cls = lineClass(line);
    // A line naming a DIFFERENT class than requested (e.g. a car line when a
    // scooter was asked) is a candidate only if nothing better is found.
    const perDay = line.match(PRICE_DAY);
    if (perDay) {
      const amt = parseAmount(perDay[1]);
      if (amt > 0 && amt !== days) {
        hits.push({
          pricePerDay: amt,
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
        });
        continue;
      }
    }
    // A whole-rental total on this line ("1750 in 5 days", or reversed
    // "3 days 900") -> per-day. Try total-first phrasing, then day-count-first.
    const total = line.match(PRICE_TOTAL) ?? line.match(PRICE_TOTAL_REV);
    if (total) {
      // PRICE_TOTAL captures (amount, days); PRICE_TOTAL_REV captures (days, amount).
      const rev = !line.match(PRICE_TOTAL);
      const whole = parseAmount(rev ? total[2] : total[1]);
      const nDays = parseInt(rev ? total[1] : total[2], 10);
      if (whole > 0 && nDays > 0 && whole > nDays) {
        hits.push({
          pricePerDay: Math.round(whole / nDays),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
        });
        continue;
      }
    }
    // A MONTHLY quote -> per-day over the real rental length when it is a
    // month-scale request (a 30-day search is exactly where shops answer in
    // months), else a calendar month.
    const month = line.match(PRICE_MONTH);
    if (month) {
      const whole = parseAmount(month[1] ?? month[2]);
      const div = days >= 28 && days <= 31 ? days : 30;
      if (whole > 0 && whole > div) {
        hits.push({
          pricePerDay: Math.round(whole / div),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
        });
        continue;
      }
    }
    // A WEEKLY quote -> /7.
    const week = line.match(PRICE_WEEK);
    if (week) {
      const whole = parseAmount(week[1] ?? week[2]);
      if (whole > 0 && whole > 7) {
        hits.push({
          pricePerDay: Math.round(whole / 7),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
        });
      }
    }
  }

  if (!hits.length) {
    // No line broke out cleanly - try the WHOLE text once (single-line replies
    // like "350 php per day" with no newlines), still skipping if it is only a
    // transfer template.
    if (!SERVICE_LINE.test(text)) {
      const whole = expandK(text);
      const m = whole.match(PRICE_DAY);
      if (m) {
        const amt = parseAmount(m[1]);
        if (amt > 0 && amt !== days) {
          return {
            pricePerDay: amt,
            currency: currencyIn(whole) ?? opts.localCurrency,
            line: text.slice(0, 120),
            classMatch: undefined,
          };
        }
      }
      // BARE-NUMBER answer to our price question ("400", "400 baht", "PHP 350
      // only"): the whole short message IS the daily price. Strict shape + a
      // sanity band so a time ("9"), a year, or a phone number never passes.
      const bare = whole.length <= 40 ? whole.match(BARE_PRICE) : null;
      if (bare) {
        const amt = parseAmount(bare[1]);
        if (amt >= 20 && amt <= 5_000_000 && amt !== days) {
          return {
            pricePerDay: amt,
            currency: currencyIn(whole) ?? opts.localCurrency,
            line: text.slice(0, 120),
            classMatch: undefined,
          };
        }
      }
    }
    return null;
  }

  // Prefer lines that MATCH the requested class; among those (or, failing that,
  // among class-agnostic lines) take the cheapest. Never pick a wrong-class line
  // when a matching or class-agnostic one exists.
  const matching = hits.filter((h) => h.classMatch === true);
  const agnostic = hits.filter((h) => h.classMatch === undefined);
  const pool = matching.length ? matching : agnostic.length ? agnostic : hits;
  return pool.reduce((best, h) => (h.pricePerDay < best.pricePerDay ? h : best));
}
