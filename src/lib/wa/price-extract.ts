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

import { parseRateLadder, tierForDays } from "./rate-ladder";

export type VehicleClassHint = "car" | "motorbike" | "scooter" | undefined;

export interface RentalPriceHit {
  pricePerDay: number;
  currency?: string;
  line: string;
  // true  = the line names the SAME class the traveller asked for
  // false = the line names a DIFFERENT class (car vs scooter)
  // undefined = the line names no class (a bare "350/day")
  classMatch?: boolean;
  // true when the number is a RESTATED list/regular price ("normally it's
  // 300/day"), not what the shop is offering right now. Never an offer.
  listPrice?: boolean;
  /** Where the amount sits in `line` - lets callers read the words around it. */
  index?: number;
  /**
   * When this price came off a DURATION LADDER ("3-7 days - 600"), the stretch
   * of days it applies to. Absent for an ordinary quote. Carrying it is what
   * lets a card say "600/day for 3-7 days" instead of pretending the board's
   * cheapest row is available to a 5-day traveller.
   */
  minDays?: number;
  maxDays?: number;
  /** The shop's own words for the range ("3-7 days", "Monthly"). */
  tierLabel?: string;
}

// Currency CODES/symbols AND the spoken WORDS shops actually type ("400 baht
// per day", "4000 baht per month") - the word forms were missing, which made
// every "<n> baht ..." quote invisible to the day/month/week patterns (a live
// dropped-offer class).
const CUR_SYM = "[$€฿₱₹₫]";
const CUR_WORDS =
  "usd|idr|rp|eur|thb|rm|php|inr|vnd|myr|aud|nzd|sgd|mxn|try|ils|zar|brl|mad|egp|lkr|npr|twd|jpy|krw" +
  "|baht|pesos?|piso|rupiah|rupees?|dong|ringgit|dollars?|euros?|shekels?|dirhams?";

// LETTER BOUNDARIES ARE NOT OPTIONAL. Without them "no-RM-ally" made every Thai
// shop that typed "normally it's 300/day" read as Malaysian Ringgit, and the app
// showed a traveller in Krabi "RM 300/day". Same class of bug: "rp" in "airport",
// "mad" in "nomad". A code may sit against a DIGIT ("350THB") but never against
// a LETTER, so the guard is letter-only, not \w-based.
//   CUR_LEAD  - currency BEFORE the number ("PHP 350"): needs a real word start.
//   CUR_TRAIL - currency AFTER the number ("350 PHP"): what precedes is already
//               a digit or space, so only the trailing guard is needed.
const CUR_LEAD = `${CUR_SYM}|\\b(?:${CUR_WORDS})(?![a-z])`;
const CUR_TRAIL = `${CUR_SYM}|(?:${CUR_WORDS})(?![a-z])`;

// Codes that are also ordinary English words. They may still let a price PATTERN
// match, but they must never NAME the currency - "I will try 300/day" is not a
// quote in Turkish lira.
const AMBIGUOUS_CUR = new Set(["try", "mad", "a"]);

// A money amount: either grouped thousands ("1,750" / "1.750" / "1 750") OR a
// plain run of digits ("1750", "350"), optional decimals. The old pattern only
// matched the grouped form, so a bare "1750" was truncated to "175".
const NUM = "(\\d{1,3}(?:[.,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

// A currency token in EITHER position around the number, and a per-day marker.
const PRICE_DAY = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:[-/]|per\\s*|a\\s+)?\\s*(?:day|d\\b|24\\s*h(?:rs?|ours?)?|/\\s*24)`,
  "i"
);
/** Global twin of PRICE_DAY - one line can carry several per-day amounts. */
const PRICE_DAY_G = new RegExp(PRICE_DAY.source, "gi");
// A total for the whole rental ("1750 in 5 days", "900 for 3 days") - divided.
const PRICE_TOTAL = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:for|in|=|:)?\\s*(\\d{1,2})\\s*days?\\b`,
  "i"
);
// The day count BEFORE the total ("3 days 900", "5 days is 1750") - also divided.
const PRICE_TOTAL_REV = new RegExp(
  `\\b(\\d{1,2})\\s*days?\\b[^\\d]{0,10}(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A whole-rental total stated WITHOUT the day count ("1000 or 1250 total",
// "2500 altogether") - the shop already knows how many days we asked for, so it
// quotes the trip. Divided by the RFQ duration. Requires the explicit total word
// so a bare number is never mistaken for a trip price.
const PRICE_TOTAL_WORD = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:in\\s+)?(?:total|altogether|all together|all in|in all|for everything|for the whole|for all)\\b`,
  "i"
);
// A MONTHLY quote ("4000 per month", "4000/month", "monthly 4000") - the format
// long-rental shops actually use, which the day-only patterns silently dropped
// (the live "3 of 4 offers vanished" failure on a 30-day search).
const PRICE_MONTH = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*month|month(?:ly)?\\s*(?:rate|price|rental)?\\s*(?:is|:|=)?\\s*(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A WEEKLY quote ("1500 a week", "weekly 1500").
const PRICE_WEEK = new RegExp(
  `(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:[-/]|per\\s*|a\\s+)\\s*week|week(?:ly)?\\s*(?:rate|price)?\\s*(?:is|:|=)?\\s*(?:${CUR_LEAD})?\\s*${NUM}`,
  "i"
);
// A BARE price answer: the whole (short) message is just an amount + optional
// currency ("400", "400 baht", "PHP 350 only") - the natural reply to "what's
// your best price per day?". Strict shape so times/phone numbers never match.
const BARE_PRICE = new RegExp(
  `^\\s*(?:${CUR_LEAD})?\\s*${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:only|net|\\.|!)?\\s*$`,
  "i"
);

/** Normalize k-notation ("150k", "1.5k") into full numbers before matching. */
function expandK(line: string): string {
  return line.replace(/(\d+(?:\.\d+)?)\s*k\b/gi, (_, n) => String(Math.round(parseFloat(n) * 1000)));
}

// A URL NEVER contains a rate. Shops paste Maps/Waze links constantly, and the
// per-day pattern happily matched inside one: "maps.app.goo.gl/FRqAc4day2rY4mF49"
// read as "4/day" and put a 4-peso scooter on the traveller's card. Stripped
// before any scanning, so neither the price nor the label can come from a link.
const URL_RX = /\b(?:https?:\/\/|www\.)\S+/gi;

// A QUALIFYING DURATION is not a rate. "Discounted Rates for Rentals of 8 Days
// or More" is a condition on the prices that follow, and it was being read as an
// 8-per-day offer. The tell is the words around the day token, never the amount.
const DURATION_BEFORE = /\b(?:rentals?\s+of|minimum|min\.?|at\s+least|more\s+than|over|from)\s*$/i;
const DURATION_AFTER = /^\s*(?:or\s+(?:more|longer|above|up)|\+|and\s+(?:up|above|over)|plus)\b/i;

/**
 * Is the amount at `index` part of a duration CONDITION rather than a price?
 * Pure so the judgement is unit-tested instead of inferred from a transcript.
 */
export function isDurationConditionAt(line: string, index: number, matched: string): boolean {
  const before = line.slice(Math.max(0, index - 24), index);
  if (DURATION_BEFORE.test(before)) return true;
  const after = line.slice(index + matched.length, index + matched.length + 24);
  return DURATION_AFTER.test(after);
}

// A line that is a transfer / tour / other service, NOT a vehicle rental.
const SERVICE_LINE =
  /\b(trip|transfer|shuttle|airport|port|pier|ferry|terminal|tour|drop\s?off service|pick\s?up service|boat|van service|habal)\b|↔|⇄|<->|<=>|<\s*-\s*>/i;

const SCOOTER_WORDS = /\b(scooter|scoopy|click|fino|filano|nmax|pcx|vespa|beat|mio|aerox|vario|moped|automatic)\b/i;
const MOTORBIKE_WORDS =
  /\b(motor\s?bike|motorcycle|manual|semi\s?auto|sportbike|dirt\s?bike|scrambler|cafe\s?racer|enduro|trail|xr|klx|crf|ttr|wr|raider|sniper)\b/i;
const CAR_WORDS = /\b(car|sedan|suv|hatchback|van|mpv|pickup|4x4|jeep|multicab)\b/i;

// ---------------------------------------------------------------------------
// LIST PRICE vs LIVE OFFER
//
// The live failure: a shop had already agreed 250/day, then wrote "That is a
// discount already, normally it's 300/day". The extractor read 300 as a fresh
// quote, so the app replaced a real ฿250 offer with a worse 300 - while the
// agent, reading the sentence properly, kept negotiating from 250. A restated
// regular / normal / usual / original price is an ANCHOR, never an offer.
//
// The cue must sit just before the number, and any "but / for you / now" style
// pivot BETWEEN the cue and the number cancels it - that is exactly the shape of
// "Normally 300 but for you 250", where 300 is the list and 250 is the offer.
// The cue must genuinely be about a PRICE. An adverb ("normally it's 300")
// always is; a bare adjective only counts when it modifies price/rate/cost -
// otherwise "Hi! Normal scooters? Some models 200 and some new 250/day" reads
// its own vehicle question as a list price and the whole menu disappears.
const LIST_CUE = new RegExp(
  "\\b(?:" +
    "normally|regularly|usually|originally|" +
    "(?:normal|regular|usual|standard|original|full|list|rack|sticker)\\s+(?:price|rate|cost|charge)s?|" +
    "list\\s+price|rack\\s+rate|before\\s+discount|without\\s+discount|was" +
    ")\\b",
  "i"
);
const OFFER_PIVOT =
  /\b(?:but|however|for\s+you|special|instead|now|today|i\s+can\s+(?:do|give|offer)|drop(?:ped)?\s+(?:it\s+)?to|discounted\s+to|final|make\s+it)\b/i;
/** How far back from the number the cue may sit and still govern it. */
const CUE_WINDOW = 60;

/**
 * Is the amount at `index` in `line` a restated LIST price rather than what the
 * shop is offering now? Pure, so the judgement is unit-tested rather than
 * inferred from a transcript.
 */
export function isListPriceAt(line: string, index: number): boolean {
  const before = line.slice(Math.max(0, index - CUE_WINDOW), index);
  const cue = [...before.matchAll(new RegExp(LIST_CUE.source, "gi"))].pop();
  if (!cue) return false;
  const between = before.slice((cue.index ?? 0) + cue[0].length);
  return !OFFER_PIVOT.test(between);
}

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

// A currency token anywhere in the line, letter-guarded on BOTH sides so a code
// buried inside an ordinary word can never name the money. `(?:^|[^a-z])` is a
// consuming stand-in for a lookbehind (kept out of the bundle for older Safari),
// which is why the token is captured in group 1. Ambiguous English words are
// skipped and the scan continues to the next candidate.
const CUR_ANYWHERE = new RegExp(`(${CUR_SYM})|(?:^|[^a-z])((?:${CUR_WORDS}))(?![a-z])`, "gi");

function codeForToken(t: string): string {
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

/** Every currency the text EXPLICITLY names, letter-guarded. Order preserved. */
export function mentionedCurrencies(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const m of text.matchAll(CUR_ANYWHERE)) {
    const tok = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!tok || AMBIGUOUS_CUR.has(tok)) continue;
    const code = codeForToken(tok);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function currencyIn(line: string): string | undefined {
  return mentionedCurrencies(line)[0];
}

/**
 * The currency to actually STORE for a reply. A foreign currency is honoured
 * only when the shop truly typed it: otherwise the shop's own region wins. This
 * is the backstop that keeps a Krabi quote in baht even if some upstream reader
 * hallucinates ringgit - a traveller must never see the wrong money.
 */
export function reconcileCurrency(
  extracted: string | undefined,
  regionCurrency: string | undefined,
  text: string
): string | undefined {
  if (!extracted) return regionCurrency;
  if (!regionCurrency || extracted === regionCurrency) return extracted;
  return mentionedCurrencies(text).includes(extracted) ? extracted : regionCurrency;
}

// SHARED-UNIT ALTERNATIVES.
//
// "Some models 200 and some new 250/day" carries ONE "/day" that governs BOTH
// numbers. Reading only the marked amount is how the live app lost the 200 tier
// entirely and showed the traveller a bare "250/day" for a shop that had two
// bikes. The unit is shared across an explicit alternation, so we walk left from
// a priced amount and adopt any number joined to it by "and / or / , / - / to",
// optionally through the words a shop puts between them.
//
// Deliberately tight: only an ALTERNATION token qualifies. "Click 125 at
// 250/day" has no such token before 250, so the 125 stays a model number and
// never becomes a price.
const ALT_TAIL = new RegExp(
  `${NUM}\\s*(?:${CUR_TRAIL})?\\s*(?:,|-|~|\\/|\\bor\\b|\\band\\b|\\bto\\b)\\s*` +
    `(?:(?:some|a|an|the|for|new|newer|old|older|used|second|hand|basic|normal|standard|models?|ones?|bikes?|scooters?|cars?|motorbikes?)\\s+){0,4}$`,
  "i"
);
const ALT_WINDOW = 70;
const MAX_ALTERNATES = 3;
// A number sitting right after a model or brand word is a MODEL, not a price -
// "a Click 125, 250/day" must not turn 125 into a second tier. Same for an
// explicit cc figure.
const MODEL_TAIL =
  /\b(?:click|scoopy|fino|filano|nmax|pcx|aerox|vario|beat|mio|vespa|forza|adv|xmax|wave|dream|raider|sniper|crf|klx|xr|honda|yamaha|suzuki|kawasaki|model|no\.?)\s*-?\s*$/i;
const CC_HEAD = /^\s*(?:cc\b|ccs\b)/i;

/**
 * Amounts to the LEFT of `idx` that share its unit through an alternation.
 * Returns them with their own index in `line` so callers keep locality.
 */
function alternatesBefore(line: string, idx: number): Array<{ amount: number; index: number }> {
  const out: Array<{ amount: number; index: number }> = [];
  let cursor = idx;
  for (let i = 0; i < MAX_ALTERNATES; i++) {
    const from = Math.max(0, cursor - ALT_WINDOW);
    const before = line.slice(from, cursor);
    const m = before.match(ALT_TAIL);
    if (!m || m.index === undefined) break;
    const amount = parseAmount(m[1]);
    const at = from + m.index + m[0].indexOf(m[1]);
    if (!(amount > 0)) break;
    // A model/brand number or a cc figure is not a price tier.
    if (MODEL_TAIL.test(line.slice(Math.max(0, at - 20), at))) break;
    if (CC_HEAD.test(line.slice(at + String(m[1]).length))) break;
    out.push({ amount, index: at });
    cursor = at;
  }
  return out;
}

/** Where in `line` the amount captured by `m` starts. */
function amountIndex(line: string, m: RegExpMatchArray, group: number): number {
  const at = m.index ?? 0;
  const inner = m[0].indexOf(m[group] ?? "");
  return inner >= 0 ? at + inner : at;
}

export interface QuotedPrices {
  /** What the shop is offering right now (null when it quoted nothing new). */
  offer: RentalPriceHit | null;
  /** A restated regular/list price - an anchor for the negotiator, never an offer. */
  listPrice: RentalPriceHit | null;
  /**
   * EVERY live per-day amount the message named, cheapest-first. `offer` is just
   * the one this function would pick; a shop saying "some models 200 and some
   * new 250/day" is offering a MENU, and collapsing that to a single number is
   * what made the app hide the 200 tier and the agent haggle a price the
   * traveller had not chosen yet. List prices are excluded - they are anchors.
   */
  allOffers: RentalPriceHit[];
}

/**
 * Extract the traveller's rental DAILY price from a messy multi-line reply.
 * Returns null when no genuine per-day rental price is present (a transfer-only
 * template, a pure greeting, or a message that only restates the LIST price) so
 * the caller can clarify rather than book a worse number.
 */
export function extractRentalDailyPrice(
  text: string,
  opts: { vehicleClass?: VehicleClassHint; durationDays?: number; localCurrency?: string } = {}
): RentalPriceHit | null {
  return extractQuotedPrices(text, opts).offer;
}

/**
 * The full read: the live offer AND any restated list price, kept apart. The
 * split matters because "that is a discount already, normally it's 300/day"
 * must never overwrite an agreed 250 - it is the shop defending its discount,
 * not raising the price.
 */
export function extractQuotedPrices(
  text: string,
  opts: { vehicleClass?: VehicleClassHint; durationDays?: number; localCurrency?: string } = {}
): QuotedPrices {
  const none: QuotedPrices = { offer: null, listPrice: null, allOffers: [] };
  if (!text || !text.trim()) return none;
  const wantClass = opts.vehicleClass;
  const days = opts.durationDays && opts.durationDays > 0 ? opts.durationDays : 1;
  const lines = text
    // Links out first - a rate never lives inside a URL.
    .replace(URL_RX, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const hits: RentalPriceHit[] = [];

  // A DURATION LADDER wins outright. When the shop sent a board - "1-2 days
  // 650 / 3-7 days 600 / 8-14 days 550 / Monthly 450" - the generic patterns
  // below read "3-7 days ... 600" as a whole-rental total (86/day) and the
  // vision half simply picked a number it liked (500/day, quoted to a traveller
  // staying five days). Neither was reading the structure that is actually
  // there. rate-ladder does, so it goes first and the rest never sees the board.
  const ladder = parseRateLadder(text, { localCurrency: opts.localCurrency });
  if (ladder.length >= 2) {
    const chosen = tierForDays(ladder, days);
    const rows: RentalPriceHit[] = ladder.map((tier) => ({
      pricePerDay: tier.pricePerDay,
      currency: tier.currency ?? opts.localCurrency,
      line: tier.line,
      classMatch: lineClass(tier.line) ? lineClass(tier.line) === wantClass : undefined,
      minDays: tier.minDays,
      maxDays: tier.maxDays,
      tierLabel: tier.label,
    }));
    // The offer is the row that COVERS this stay - never the cheapest row on
    // the board. A five-day traveller cannot have the 15-29 day rate, and
    // handing the whole board to `pickCheapestOnSpec` is precisely how they
    // came to be quoted one.
    const offer = rows.find((r) => r.minDays === chosen?.minDays && r.maxDays === chosen?.maxDays);
    return {
      offer: offer ?? null,
      listPrice: null,
      // Every tier still reaches the caller so the card can show the real
      // ladder ("stay 8 days and it drops to 550") with each row's own range.
      allOffers: rows.slice().sort((a, b) => a.minDays! - b.minDays!),
    };
  }

  for (const rawLine of lines) {
    if (SERVICE_LINE.test(rawLine)) continue; // transfer / tour / shuttle - skip
    const line = expandK(rawLine);
    const cls = lineClass(line);
    // A line naming a DIFFERENT class than requested (e.g. a car line when a
    // scooter was asked) is a candidate only if nothing better is found.
    // EVERY per-day amount on the line, not just the first: shops routinely put
    // the anchor and the offer in one breath ("Normally 300/day but for you
    // 250/day"), and reading only the first left the traveller with the anchor.
    let tookDaily = false;
    for (const perDay of line.matchAll(PRICE_DAY_G)) {
      const amt = parseAmount(perDay[1]);
      if (!(amt > 0) || amt === days) continue;
      const at = amountIndex(line, perDay, 1);
      // "...for Rentals of 8 Days or More:" states WHEN the rates below apply.
      if (isDurationConditionAt(line, at, perDay[0])) continue;
      hits.push({
        pricePerDay: amt,
        currency: currencyIn(line) ?? opts.localCurrency,
        line: rawLine,
        classMatch: cls ? cls === wantClass : undefined,
        listPrice: isListPriceAt(line, at),
        index: at,
      });
      // Numbers joined to this one by "and / or / ," share its per-day unit.
      for (const alt of alternatesBefore(line, at)) {
        if (alt.amount === days) continue;
        hits.push({
          pricePerDay: alt.amount,
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, alt.index),
          index: alt.index,
        });
      }
      tookDaily = true;
    }
    if (tookDaily) continue;
    // A trip total with no day count ("1000 or 1250 total") -> per-day over the
    // duration we actually asked for. Alternates share the unit here too, which
    // is what turns "1000 or 1250 total" into a real two-tier menu.
    const totalWord = days > 1 ? line.match(PRICE_TOTAL_WORD) : null;
    if (totalWord) {
      const at = amountIndex(line, totalWord, 1);
      const amounts = [
        { amount: parseAmount(totalWord[1]), index: at },
        ...alternatesBefore(line, at),
      ];
      let took = false;
      for (const a of amounts) {
        if (!(a.amount > days)) continue;
        hits.push({
          pricePerDay: Math.round(a.amount / days),
          currency: currencyIn(line) ?? opts.localCurrency,
          line: rawLine,
          classMatch: cls ? cls === wantClass : undefined,
          listPrice: isListPriceAt(line, a.index),
          index: a.index,
        });
        took = true;
      }
      if (took) continue;
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
          listPrice: isListPriceAt(line, amountIndex(line, total, rev ? 2 : 1)),
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
          listPrice: isListPriceAt(line, amountIndex(line, month, month[1] ? 1 : 2)),
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
          listPrice: isListPriceAt(line, amountIndex(line, week, week[1] ? 1 : 2)),
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
      for (const m of whole.matchAll(PRICE_DAY_G)) {
        const amt = parseAmount(m[1]);
        if (!(amt > 0) || amt === days) continue;
        hits.push({
          pricePerDay: amt,
          currency: currencyIn(whole) ?? opts.localCurrency,
          line: text.slice(0, 120),
          classMatch: undefined,
          listPrice: isListPriceAt(whole, amountIndex(whole, m, 1)),
        });
      }
      // BARE-NUMBER answer to our price question ("400", "400 baht", "PHP 350
      // only"): the whole short message IS the daily price. Strict shape + a
      // sanity band so a time ("9"), a year, or a phone number never passes.
      const bare = hits.length === 0 && whole.length <= 40 ? whole.match(BARE_PRICE) : null;
      if (bare) {
        const amt = parseAmount(bare[1]);
        if (amt >= 20 && amt <= 5_000_000 && amt !== days) {
          hits.push({
            pricePerDay: amt,
            currency: currencyIn(whole) ?? opts.localCurrency,
            line: text.slice(0, 120),
            classMatch: undefined,
          });
        }
      }
    }
    if (!hits.length) return none;
  }

  // A restated LIST price is kept, but only as an anchor - it must never win the
  // offer slot, even when it is the ONLY number in the message. That is the
  // whole point: "normally it's 300/day" leaves an agreed 250 standing.
  const listOnly = hits.filter((h) => h.listPrice === true);
  const live = hits.filter((h) => h.listPrice !== true);
  return {
    offer: pickCheapestOnSpec(live),
    listPrice: pickCheapestOnSpec(listOnly),
    allOffers: dedupeByPrice(live).sort((a, b) => a.pricePerDay - b.pricePerDay),
  };
}

/** One entry per distinct price - the same amount restated is not a second tier. */
function dedupeByPrice(hits: RentalPriceHit[]): RentalPriceHit[] {
  const seen = new Map<number, RentalPriceHit>();
  for (const h of hits) {
    const prev = seen.get(h.pricePerDay);
    // Prefer the richer hit: one that names a class beats a bare number.
    if (!prev || (prev.classMatch === undefined && h.classMatch !== undefined)) {
      seen.set(h.pricePerDay, h);
    }
  }
  return [...seen.values()];
}

/**
 * Prefer lines that MATCH the requested class; among those (or, failing that,
 * among class-agnostic lines) take the cheapest. Never pick a wrong-class line
 * when a matching or class-agnostic one exists.
 */
function pickCheapestOnSpec(hits: RentalPriceHit[]): RentalPriceHit | null {
  if (!hits.length) return null;
  const matching = hits.filter((h) => h.classMatch === true);
  const agnostic = hits.filter((h) => h.classMatch === undefined);
  const pool = matching.length ? matching : agnostic.length ? agnostic : hits;
  return pool.reduce((best, h) => (h.pricePerDay < best.pricePerDay ? h : best));
}
