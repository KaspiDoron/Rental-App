// Plan-tiered messaging capacity - the "how many new shops, how fast" model.
//
// The OLD model was a single fixed `max_new_contacts_per_day` (15) crushed by
// a 7-day warm-up ramp (day-0 multiplier ~0.14 => 2 new shops for the WHOLE
// day) that reset only at UTC midnight. Effect: a fresh number could introduce
// itself to ~2 shops, then everything parked "until tomorrow morning". That is
// the "I can only message a few shops before it all postpones" report.
//
// The NEW model is a ROLLING WINDOW per plan: capacity refreshes continuously
// as the oldest introduction ages out of the window, so a user never hits a
// hard once-a-day wall - at worst they wait `windowHours` for the next slot,
// and usually far less. Plans buy real capacity (they used to be cosmetic:
// `vip-concurrency` was sold but never read by any cap code).
//
// Protection is NON-NEGOTIABLE and unchanged in spirit: the per-number rate
// governors (min-gap 50-120s, burst cooldown, business hours, reply-rate
// breaker, risk auto-pause, warm-up ramp) still bound the actual send RATE.
// This module only governs HOW MANY distinct new shops enter the funnel per
// rolling window, and lifts the warm-up floor so early days are usable, not
// crippled. Pure + isomorphic so the guard, the mass route, the pricing page
// and the tests all share one source of truth.

export type CapacityPlan = "free" | "pro" | "ultra";

export interface PlanCapacity {
  /** New-shop introductions allowed per rolling window. */
  newContacts: number;
  /** The rolling window length, in hours. */
  windowHours: number;
  /** Upper bound on sends/hour for this plan (trust can raise the floor). */
  hourCap: number;
}

// The owner's targets - a user must be able to START their FULL plan budget of
// conversations in the FIRST session, within minutes, on day 0:
//   free:  10 new shops / 6h
//   pro:   30 new shops / 4h
//   ultra: 40 new shops / 3h
// hourCap == newContacts: the hourly velocity ceiling never sits BELOW the
// conversation budget, so a within-budget batch is never split across hour
// windows (the "it said 18:24 then jumped to 19:20" bug). The real send RATE is
// governed by the jittered min-gap (fast enough to clear the full budget in
// ~10-15 min) plus the reply-rate circuit breaker + daily ceiling, which halt a
// number that is actually behaving like a spammer.
export const PLAN_CAPACITY: Record<CapacityPlan, PlanCapacity> = {
  free: { newContacts: 10, windowHours: 6, hourCap: 10 },
  pro: { newContacts: 30, windowHours: 4, hourCap: 30 },
  ultra: { newContacts: 40, windowHours: 3, hourCap: 40 },
};

export function normalizeCapacityPlan(plan?: string | null): CapacityPlan {
  const p = (plan ?? "").toLowerCase();
  if (p === "ultra" || p === "business") return "ultra";
  if (p === "pro") return "pro";
  return "free";
}

export function planCapacity(plan?: string | null): PlanCapacity {
  return PLAN_CAPACITY[normalizeCapacityPlan(plan)];
}

/**
 * Gentle warm-up: a brand-new number ramps from a HIGH floor (85% on day 0) to
 * 100% over `warmupDays`. It only ever nudges the RATE headroom above the plan
 * budget - it can never crush the number of conversations a user may start
 * (that is the owner's explicit requirement: full budget usable day 0). The real
 * safety net for a fresh number is the reply-rate circuit breaker + risk
 * auto-pause + daily ceiling, which halt a number that is actually spamming.
 */
export function warmupFactor(ageDays: number, warmupDays: number): number {
  if (!(ageDays < warmupDays)) return 1;
  const linear = (ageDays + 1) / Math.max(1, warmupDays);
  return Math.max(0.85, Math.min(1, linear));
}

/**
 * Effective new-shop introductions for this window. The FULL plan budget is
 * available immediately, on day 0 - warm-up never reduces how many distinct
 * conversations a user may start (only the send rate ramps, and even that stays
 * at/above the budget). A brand-new ultra user gets all 40 conversations at once.
 */
export function effectiveNewContactCap(
  plan: string | null | undefined,
  _ageDays: number,
  _warmupDays: number
): number {
  return planCapacity(plan).newContacts;
}

/** Effective sends/hour ceiling: the higher of the trust-scaled base and the
 *  plan headroom, warm-up ramped, but NEVER below the plan's conversation
 *  budget - so a within-budget batch is never split across hour windows. */
export function effectiveHourCap(
  plan: string | null | undefined,
  trustBaseHourCap: number,
  ageDays: number,
  warmupDays: number
): number {
  const cap = planCapacity(plan);
  const raw = Math.max(trustBaseHourCap, cap.hourCap) * warmupFactor(ageDays, warmupDays);
  return Math.max(cap.newContacts, Math.round(raw));
}

/**
 * Given the timestamps (ISO) of the distinct introductions still inside the
 * rolling window, when does the NEXT slot free? = the oldest one ages out.
 * Returns now (ISO) when under budget (a slot is already free).
 */
export function nextIntroSlotIso(
  introTimestampsAsc: string[],
  windowHours: number,
  cap: number,
  nowMs: number
): string {
  const used = introTimestampsAsc.length;
  if (used < cap) return new Date(nowMs).toISOString();
  // The (used - cap + 1)-th oldest must age out before a slot opens. With
  // used === cap that is simply the oldest introduction.
  const idx = Math.max(0, used - cap);
  const anchor = introTimestampsAsc[idx] ?? introTimestampsAsc[0];
  const at = Date.parse(anchor);
  if (!Number.isFinite(at)) return new Date(nowMs + windowHours * 3600_000).toISOString();
  return new Date(at + windowHours * 3600_000).toISOString();
}
