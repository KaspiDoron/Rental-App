import "server-only";
import { sbSelect } from "./runtime-config";

// The SEARCH-SESSION boundary + the ONE rival-selection predicate.
//
// "Use the best competing offer from THIS search session" was implemented as
// a flat 18-hour window - which leaked yesterday's offers into today's
// leverage (stale numbers the traveller is no longer comparing) and, being
// duplicated across the engine / agent-loop / bargain-draft / simulator,
// meant the playground never exercised the real selection logic at all.
//
// The boundary is server-derived (the user's latest `searches` row - the
// same signal the deals dashboard and the mass-bargain session cap already
// group by), clamped to 18h so an ancient still-open session cannot
// resurrect stale leverage either. The predicate is PURE and shared: the
// live engine and the playground filter through the exact same function, so
// what the owner tests is what production runs.

const STALE_CAP_MS = 18 * 3600_000;

/** ISO boundary: offers at/after this moment belong to the CURRENT session. */
export async function sessionSinceIso(userEmail: string): Promise<string> {
  return (await currentSession(userEmail)).sinceIso;
}

/**
 * The traveller's CURRENT search session: its id (for exact rival scoping) and
 * an ISO time boundary (the belt-and-suspenders fallback). The id is the single
 * source of truth - it is the SAME id offers are stamped with (agent-loop
 * search_id), so a rival scoped by id can never be an offer from a DIFFERENT
 * search that merely happens to fall inside an 18h window.
 */
export async function currentSession(
  userEmail: string
): Promise<{ id?: number; sinceIso: string }> {
  const fallback = new Date(Date.now() - STALE_CAP_MS).toISOString();
  const rows = await sbSelect<{ id: number; created_at: string }>(
    "searches",
    `select=id,created_at&user_email=eq.${encodeURIComponent(
      userEmail
    )}&order=created_at.desc&limit=1`
  ).catch(() => []);
  const start = rows[0]?.created_at;
  return {
    id: rows[0]?.id,
    // The LATER bound wins: never before this session started, never staler
    // than 18h even inside a long-running session.
    sinceIso: start && start > fallback ? start : fallback,
  };
}

/**
 * The one server-side rival lookup every surface shares (engine IO,
 * legacy agent-loop, bargain-draft). Fetches this session's offers and runs
 * them through the pure predicate below.
 */
export async function cheapestRivalFor(
  userEmail: string,
  args: { vendorId: string; currency: string; vehicleKey: string; belowPrice: number }
): Promise<number | undefined> {
  const session = await currentSession(userEmail);

  // HOT PATH (Module 2): O(log n) Redis ZSET read, scoped to this exact
  // session + vehicle + currency. Only authoritative for sessions the worker
  // runtime ingested (the `live` flag) - on Vercel or for a Vercel-era
  // session this returns null and the Postgres path below stays the truth.
  if (session.id != null) {
    const { cheapestCachedRival } = await import("./rival-cache");
    const cached = await cheapestCachedRival({
      searchId: session.id,
      vehicleKey: args.vehicleKey,
      currency: args.currency,
      excludeVendorId: args.vendorId,
      belowPrice: args.belowPrice,
    });
    if (cached != null) return cached;
  }

  const rows = await sbSelect<{
    vendor_id: string;
    price_per_day: number;
    currency: string;
    vehicle_key: string | null;
    effective_daily_rate: number | null;
    created_at: string;
    search_id: number | null;
  }>(
    "offers",
    `select=vendor_id,price_per_day,currency,vehicle_key,effective_daily_rate,created_at,search_id&user_email=eq.${encodeURIComponent(
      userEmail
    )}&simulated=eq.false&currency=eq.${encodeURIComponent(
      args.currency
    )}&vehicle_key=eq.${encodeURIComponent(args.vehicleKey)}&created_at=gte.${encodeURIComponent(
      session.sinceIso
    )}&order=price_per_day.asc&limit=24`
  ).catch(() => []);
  return pickCheapestRival(
    rows.map((r) => ({
      vendorId: r.vendor_id,
      pricePerDay: r.price_per_day,
      currency: r.currency,
      vehicleKey: r.vehicle_key,
      effectiveDailyRate: r.effective_daily_rate,
      createdAt: r.created_at,
      searchId: r.search_id,
    })),
    { ...args, sinceIso: session.sinceIso, searchId: session.id }
  );
}

export interface RivalOffer {
  vendorId: string;
  pricePerDay: number;
  currency: string;
  vehicleKey?: string | null;
  /** Duration-aware daily rate (discounted weekly deals etc.) when known. */
  effectiveDailyRate?: number | null;
  createdAt: string; // ISO
  /** The search this offer belongs to - the exact, leak-proof session key. */
  searchId?: number | null;
}

/**
 * The cheapest REAL rival for a negotiation - pure and deterministic.
 * Rules (each one deliberate):
 *  - same session only (createdAt >= sinceIso)
 *  - same currency EXACTLY (comparing across currencies without FX invents
 *    leverage - a mismatch is surfaced by the caller, never guessed through)
 *  - same vehicle class exactly
 *  - a DIFFERENT shop
 *  - duration-aware: the effective daily rate (when known) beats the sticker
 *    per-day price, so a weekly-deal rival is compared honestly
 *  - strictly cheaper than the quote being negotiated
 */
export function pickCheapestRival(
  offers: RivalOffer[],
  args: {
    vendorId: string;
    currency: string;
    vehicleKey: string;
    belowPrice: number;
    sinceIso: string;
    /** The current search's id. When known, a rival MUST belong to it -
     * exact-match scoping that a time window alone cannot guarantee. */
    searchId?: number | null;
  }
): number | undefined {
  let best: number | undefined;
  for (const o of offers) {
    if (o.vendorId === args.vendorId) continue;
    if (o.currency !== args.currency) continue;
    // FAIL CLOSED on an unknown vehicle: a null vehicle_key must NEVER be
    // treated as "matches anything" - that let a wrong-vehicle offer qualify as
    // a rival. A rival must POSITIVELY match the requested vehicle bucket.
    if (!o.vehicleKey || o.vehicleKey !== args.vehicleKey) continue;
    // EXACT SESSION SCOPING: when we know this negotiation's search id, a rival
    // must belong to the SAME search. This is leak-proof where the 18h time
    // window is not - two searches minutes apart no longer cross-contaminate.
    // Only when the session id is unknown do we fall back to the time boundary.
    if (args.searchId != null) {
      if (o.searchId !== args.searchId) continue;
    } else if (o.createdAt < args.sinceIso) {
      continue;
    }
    const rate =
      typeof o.effectiveDailyRate === "number" && o.effectiveDailyRate > 0
        ? Math.min(o.effectiveDailyRate, o.pricePerDay)
        : o.pricePerDay;
    if (!(rate > 0) || rate >= args.belowPrice) continue;
    if (best === undefined || rate < best) best = rate;
  }
  return best;
}
