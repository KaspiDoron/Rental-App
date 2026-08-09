// COHORTS - the primitive that makes a behaviour change reversible.
//
// A repo-wide search for `canary`, `cohort`, `rollout` and `feature_flag`
// returned zero hits in src/. Every switch in this product was therefore a
// 100%-of-fleet switch that landed within the config cache's 30 seconds and
// could not be rolled back to any prior value. That is the reason the plan
// ranks this above everything it gates: on a fleet of travellers' personal
// WhatsApp numbers, an irreversible change is not a feature flag, it is a bet.
//
// It is also what makes the warm-up gate MEASURABLE. Without a holdout, "the
// gate improves conversion" is unfalsifiable forever: there is no population to
// compare against, so any number you read afterwards is consistent with the
// gate helping, hurting, or doing nothing. With one, a single number settles it.
//
// Deliberately tiny and dependency-light: one hash, one config read, no tables,
// no writes. It has to be cheap enough that a caller never hesitates to gate
// something on it.

import "server-only";
import { createHash } from "crypto";
import { getConfig } from "./runtime-config";

/**
 * Stable bucket 0-99 for an identity.
 *
 * Deterministic across instances, deploys and restarts, because the assignment
 * has to survive a Cloud Run cold start: a user who flips cohort between two
 * requests would see the gate appear and disappear, and would poison the very
 * comparison the cohort exists to enable.
 *
 * Hash, not modulo-of-something-meaningful. Emails cluster hard on their first
 * character and on the domain, so anything cheaper than a hash gives buckets
 * that correlate with the population.
 */
export function bucketOf(identity: string): number {
  const key = identity.trim().toLowerCase();
  if (!key) return 0;
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return parseInt(hex, 16) % 100;
}

function csv(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface CohortDecision {
  member: boolean;
  /** How they got in - shown in the admin so a surprise can be explained. */
  reason: "flag-off" | "named" | "percent" | "outside";
  bucket: number;
}

/**
 * Is this user in the named cohort?
 *
 * Membership is `<NAME>_PCT` (bucket < pct) OR an explicit listing in
 * `<NAME>_LIST`. The list wins so the owner can always pull one specific
 * account in for testing without moving the percentage for everybody else.
 *
 * A cohort with no percentage and no list is EMPTY, not full. That direction
 * matters: a mistyped config name should roll a change out to nobody, never to
 * the whole fleet.
 */
export async function cohortDecision(name: string, identity: string): Promise<CohortDecision> {
  const bucket = bucketOf(identity);
  const [listRaw, pctRaw] = await Promise.all([
    getConfig(`${name}_LIST`),
    getConfig(`${name}_PCT`),
  ]);
  if (csv(listRaw).includes(identity.trim().toLowerCase())) {
    return { member: true, reason: "named", bucket };
  }
  const pct = Number(pctRaw);
  if (Number.isFinite(pct) && pct > 0 && bucket < Math.min(100, pct)) {
    return { member: true, reason: "percent", bucket };
  }
  return { member: false, reason: pctRaw || listRaw ? "outside" : "flag-off", bucket };
}

export async function inCohort(name: string, identity: string): Promise<boolean> {
  return (await cohortDecision(name, identity)).member;
}

// ---- The warm-up holdout ---------------------------------------------------

/** Cohort name for the warm-up gate holdout. */
export const WARMUP_HOLDOUT = "WARMUP_HOLDOUT";

/**
 * Users in the holdout may buy immediately, bypassing the warm-up gate.
 *
 * THIS IS A MEASUREMENT INSTRUMENT, NOT A PERK, and the distinction shows up in
 * one place: the holdout must never be told it is in a holdout. It sees the
 * ordinary purchasable upgrade sheet, because a user who knows they are in an
 * experiment stops being a control.
 *
 * Ships at 0% - the experiment is opt-in by the owner, and a gate nobody is
 * exempt from is the correct default until someone decides to measure it.
 */
export async function inWarmupHoldout(email: string): Promise<boolean> {
  try {
    return await inCohort(WARMUP_HOLDOUT, email);
  } catch {
    // A cohort read that fails must not hand out free access to everyone, and
    // must not lock out everyone either. Not-a-member is the neutral answer:
    // the user simply meets the normal gate.
    return false;
  }
}
