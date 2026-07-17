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

// Tuned to the owner's targets, validated against the rate governors:
//   free:  10 new shops / 6h   (~1.7/h sustained)
//   pro:   15 new shops / 4h   (~3.8/h sustained)
//   ultra: 40 new shops / 3h   (~13/h sustained)
// hourCap is the per-plan velocity ceiling; the 50-120s min-gap independently
// caps the true rate well below it, so these are safe headroom, not a blast.
export const PLAN_CAPACITY: Record<CapacityPlan, PlanCapacity> = {
  free: { newContacts: 10, windowHours: 6, hourCap: 6 },
  pro: { newContacts: 15, windowHours: 4, hourCap: 10 },
  ultra: { newContacts: 40, windowHours: 3, hourCap: 18 },
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
 * Humane warm-up: a brand-new number still ramps, but from a usable FLOOR
 * (45% of capacity on day 0) up to 100% over `warmupDays`, instead of the old
 * ~14% day-0 multiplier that made a fresh number nearly mute. The per-send
 * rate governors keep a new number safe even at the 45% floor.
 */
export function warmupFactor(ageDays: number, warmupDays: number): number {
  if (!(ageDays < warmupDays)) return 1;
  const linear = (ageDays + 1) / Math.max(1, warmupDays);
  return Math.max(0.45, Math.min(1, linear));
}

/** Effective new-shop introductions for this window (plan x warm-up). */
export function effectiveNewContactCap(
  plan: string | null | undefined,
  ageDays: number,
  warmupDays: number
): number {
  const cap = planCapacity(plan).newContacts;
  return Math.max(1, Math.round(cap * warmupFactor(ageDays, warmupDays)));
}

/** Effective sends/hour ceiling: the higher of the trust-scaled base and the
 *  plan's headroom, then warm-up ramped. Keeps replies flowing on busy plans
 *  while a low-trust number stays near the conservative base. */
export function effectiveHourCap(
  plan: string | null | undefined,
  trustBaseHourCap: number,
  ageDays: number,
  warmupDays: number
): number {
  const planHour = planCapacity(plan).hourCap;
  const raw = Math.max(trustBaseHourCap, planHour) * warmupFactor(ageDays, warmupDays);
  return Math.max(1, Math.round(raw));
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
