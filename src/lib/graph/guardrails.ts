// NEGOTIATION-INTEGRITY GUARDRAILS - the deterministic pre-send validation an
// LLM draft must survive before it can reach a real rental shop. These catch
// the three catastrophic failure classes an autoregressive model produces no
// matter how carefully it is prompted:
//
//   1. FABRICATED LEVERAGE  - "another shop quoted 220" when NO rival exists.
//   2. INVERTED / SUB-FLOOR MATH - proposing MORE than the shop's live price
//      (600 when they offered 500), or LESS than the real market floor (200
//      when the floor is 280) - both breach the negotiation's basic arithmetic.
//   3. HARD-CONSTRAINT BREACH - bargaining on / accepting a vehicle that
//      violates the traveller's immutable filter (a manual was requested, the
//      shop pivoted to an automatic scooter).
//
// Pure + fully unit-tested: no IO, no server-only, so the engine, the
// playground and the tests all exercise byte-for-byte identical logic.

import type { ExtractedOffer } from "../agents";
import type { StructuredRFQ } from "../types";

// ---------------------------------------------------------------------------
// Money-number extraction (the hard part: telling a PRICE from a cc / day / %)
// ---------------------------------------------------------------------------

// A unit suffix that proves a number is NOT a price (immediately trailing it,
// optionally after one space). "125cc", "45,000 km", "4 days", "50 %".
const UNIT_SUFFIX =
  /^(?:\s?)(cc|km|kmh|km\/h|kg|%|percent|hp|cm|mm|mins?|minutes?|hrs?|hours?|days?|day|nights?|weeks?|months?|seats?|people|persons?|pax|yo|years?|am|pm|:\d)/i;

/**
 * Every PRICE-scale number in a message, with the non-price numbers removed:
 *  - numbers glued to a unit ("125cc", "4 days", "45,000 km")
 *  - the caller's known spec numbers (duration, engine cc, seats, ...)
 *  - clock times ("10:30")
 * Thousands separators (",", ".", spaces between 3-digit groups) are tolerated
 * and stripped so "1,200" and "1200" read identically. Deliberately
 * conservative: when in doubt a number is KEPT (a real price wrongly dropped is
 * a missed guard; a stray non-price kept only risks an over-cautious re-compose).
 */
export function extractPriceNumbers(text: string, excludeExact: number[] = []): number[] {
  if (!text) return [];
  const exclude = new Set(excludeExact.filter((n) => Number.isFinite(n) && n > 0));
  const out: number[] = [];
  // Match a run of digits with optional thousands grouping. Capture where it
  // ends so we can inspect the immediately-following unit suffix.
  const rx = /(\d{1,3}(?:[.,  ]\d{3})+|\d+)(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const raw = m[1];
    const after = text.slice(rx.lastIndex);
    const before = text.slice(0, m.index);
    // A clock time ("10:30") - the ":" guard, or a unit suffix -> not a price.
    if (UNIT_SUFFIX.test(after)) continue;
    // A time like "10:30" leaves ":30" after the "10" (caught above) but also
    // guard a leading ratio "1:200".
    if (/^\s?:/.test(after)) continue;
    // The minute half of a time ("...10:30") or a ratio's tail is preceded by
    // a colon - not a standalone price.
    if (/:$/.test(before)) continue;
    const n = Number(raw.replace(/[.,  ]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (exclude.has(n)) continue;
    out.push(n);
  }
  return out;
}

// A phrase that CLAIMS a competing shop's price ("another shop quoted ...",
// "other guy gave me ...", "elsewhere it's ..."). Paired with a number this is
// leverage the message is ASSERTING as fact - it must be a real rival, never
// invented. Vague comparisons WITHOUT a number ("I'm comparing a few shops")
// are honest and deliberately NOT matched.
const RIVAL_CLAIM =
  /(another|other|different|nearby|else\s?where|competitor|next\s?door|down\s+the\s+(?:road|street)|another\s+(?:shop|place|guy|store)|other\s+(?:shop|place|guy|store))/i;

/**
 * The specific competing PRICE a message asserts, if any. Scans a window around
 * every rival-claim phrase for a price-scale number. Returns the first such
 * number, or undefined when the message makes no numeric rival claim.
 */
export function claimedRivalNumber(text: string, excludeExact: number[] = []): number | undefined {
  if (!text || !RIVAL_CLAIM.test(text)) return undefined;
  const exclude = new Set(excludeExact.filter((n) => Number.isFinite(n) && n > 0));
  // Look at each rival-claim phrase and the ~40 chars around it for a number.
  const rx = new RegExp(RIVAL_CLAIM.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const start = Math.max(0, m.index - 12);
    const window = text.slice(start, m.index + m[0].length + 40);
    const nums = extractPriceNumbers(window, [...exclude]);
    if (nums.length) return nums[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The outbound numeric check
// ---------------------------------------------------------------------------

export type NumberViolation = "fabricated-rival" | "below-floor" | "above-quote";

export interface NumberCheckArgs {
  text: string;
  /** The shop's own current/live price - our ask must never EXCEED it. */
  ceiling?: number;
  /** The real market floor (same currency) - our ask must never go BELOW it. */
  floor?: number;
  /** The ONE real rival price, when a cheaper same-session offer exists. */
  rivalPrice?: number;
  /** Non-price numbers to ignore (duration days, engine cc, seats, ...). */
  excludeExact?: number[];
  /** Only the ask-a-price node needs the floor/ceiling checks. */
  checkAskBounds: boolean;
}

export interface NumberCheckResult {
  ok: boolean;
  violation?: NumberViolation;
  detail: string;
  offending?: number;
}

const RIVAL_TOLERANCE = 0.05; // a claimed rival within 5% of the real one is fine
const BOUND_TOLERANCE = 0.02; // 2% rounding slack on floor/ceiling comparisons

/**
 * Validate the numbers a drafted message is about to assert. Deterministic and
 * order-stable: fabricated-rival is checked first (a lie is the worst), then
 * the floor, then the inverted-ask ceiling.
 */
export function checkOutboundNumbers(args: NumberCheckArgs): NumberCheckResult {
  const { text, ceiling, floor, rivalPrice, excludeExact = [], checkAskBounds } = args;

  // 1) FABRICATED LEVERAGE - a numeric rival claim with no matching real rival.
  const claimed = claimedRivalNumber(text, excludeExact);
  if (claimed !== undefined) {
    const backed =
      rivalPrice !== undefined &&
      Math.abs(claimed - rivalPrice) <= Math.max(1, rivalPrice * RIVAL_TOLERANCE);
    if (!backed) {
      return {
        ok: false,
        violation: "fabricated-rival",
        offending: claimed,
        detail: rivalPrice
          ? `message claims a rival at ${claimed} but the only real rival is ${rivalPrice}`
          : `message claims a rival price of ${claimed} but no competing offer exists in this session`,
      };
    }
  }

  if (!checkAskBounds) return { ok: true, detail: "no price bounds to check" };

  // Every price-scale number the message names (excluding the known non-price
  // spec numbers and any real rival, which is legitimately below the floor-safe
  // band only when it genuinely undercuts - but a real rival is by construction
  // >= floor, so it never trips the floor check).
  const nums = extractPriceNumbers(text, excludeExact);

  // 2) SUB-FLOOR - never name a price below the real market floor.
  if (floor && floor > 0) {
    const lowest = Math.min(...(nums.length ? nums : [Infinity]));
    if (Number.isFinite(lowest) && lowest < floor * (1 - BOUND_TOLERANCE)) {
      return {
        ok: false,
        violation: "below-floor",
        offending: lowest,
        detail: `message names ${lowest}, below the market floor of ${floor}`,
      };
    }
  }

  // 3) INVERTED ASK - never name a price ABOVE the shop's live quote (we are
  // asking for LESS, always). Catches "can you do 600?" after they offered 500.
  if (ceiling && ceiling > 0) {
    const highest = Math.max(...(nums.length ? nums : [-Infinity]));
    if (Number.isFinite(highest) && highest > ceiling * (1 + BOUND_TOLERANCE)) {
      return {
        ok: false,
        violation: "above-quote",
        offending: highest,
        detail: `message names ${highest}, above the shop's current price of ${ceiling} (an inverted ask)`,
      };
    }
  }

  return { ok: true, detail: "numbers within [floor, quote]" };
}

// ---------------------------------------------------------------------------
// Hard feature constraints (transmission / class the traveller pinned)
// ---------------------------------------------------------------------------

/**
 * Did the traveller pin an IMMUTABLE vehicle feature? A specified transmission
 * (manual vs automatic) or a specific car body type is a hard filter - the
 * agent must never silently accept a vehicle that violates it.
 */
export function hasHardConstraint(rfq: StructuredRFQ | null | undefined): boolean {
  if (!rfq) return false;
  if (rfq.transmission === "manual" || rfq.transmission === "automatic") return true;
  if (rfq.vehicleClass === "car" && rfq.carType && rfq.carType !== "any") return true;
  return false;
}

/**
 * The shop's reply is for a vehicle that BREACHES a hard constraint. We trust
 * the extractor's matchesSpec verdict (it compares the shop's vehicle to the
 * exact request) and only escalate to "breach" when the traveller actually
 * pinned a hard feature - a soft cc/model mismatch is a clarify, a hard
 * transmission/type mismatch is a decline.
 */
export function hardConstraintBreached(
  rfq: StructuredRFQ | null | undefined,
  extraction: ExtractedOffer | null | undefined
): boolean {
  if (!extraction || extraction.matchesSpec !== false) return false;
  if (!hasHardConstraint(rfq)) return false;
  // A price for the wrong vehicle only matters once there IS a price to accept
  // or bargain on; a bare "sorry only automatic" with no number is handled by
  // the normal clarify path.
  return Boolean(extraction.found && extraction.pricePerDay);
}

const VEHICLE_WORD = (rfq: StructuredRFQ): string => {
  if (rfq.vehicleClass === "car") {
    const bits = [
      rfq.transmission !== "any" ? rfq.transmission : "",
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      "car",
    ].filter(Boolean);
    return bits.join(" ");
  }
  const cc = rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : "";
  const trans = rfq.transmission === "manual" ? "manual " : rfq.transmission === "automatic" ? "automatic " : "";
  const base = rfq.vehicleClass === "scooter" ? "scooter" : "motorbike";
  return `${cc}${trans}${base}`.trim();
};

/**
 * The message the agent sends INSTEAD of bargaining on a wrong-vehicle offer:
 * a short, warm, non-native decline that restates the hard requirement and
 * asks if they have the right one - never accepts the pivot. Deterministic so
 * it never reintroduces a hallucinated price.
 */
export function hardConstraintDecline(rfq: StructuredRFQ): string {
  const want = VEHICLE_WORD(rfq);
  return `Ah sorry, i really need a ${want} - that is what i must have. Do you have that one? If not no problem, thank you 🙏`;
}

// ---------------------------------------------------------------------------
// Deterministic safe bargain (the graceful fallback when a draft is unsafe)
// ---------------------------------------------------------------------------

/**
 * A minimal, arithmetically-sane ask used ONLY when an LLM bargain draft failed
 * the numeric check but a valid target still exists. Never invents a rival;
 * names the target (which is already clamped to [floor, quote) by the ladder).
 * Returns null when no honest ask is possible (target missing / not below quote).
 */
export function buildSafeBargainAsk(args: {
  target?: number;
  ceiling?: number;
  floor?: number;
  durationDays?: number;
  currency: string;
  money: (n: number, cur: string) => string;
}): string | null {
  const { target, ceiling, floor, durationDays, currency, money } = args;
  if (!target || target <= 0) return null;
  if (ceiling && target >= ceiling) return null; // not actually a discount
  if (floor && target < floor) return null; // never below the floor
  const days = durationDays && durationDays > 1 ? ` for the ${durationDays} days` : "";
  return `Thank you my friend! For me is a bit too much. Can you do ${money(target, currency)}/day${days}? Then i book with you 🙏`;
}
