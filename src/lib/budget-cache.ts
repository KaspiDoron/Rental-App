// PLAN-TIER OUTREACH BUDGETS - Redis hot state (Module 6 of the GCP migration).
//
// Two gates the cold-outreach batch flow consults BEFORE it allocates any work,
// so a 40-shop campaign never runs a block loop or a heavy Postgres scan:
//
//   1. INTRO-WINDOW MIRROR - a read-through cache of the rolling new-contact
//      budget. The authoritative count is `introductionsInWindow` (a
//      whatsapp_messages scan in wa-guard); here it is seeded ONCE into a ZSET
//      keyed by recipient (score = send time), then every later check is an
//      O(log n) ZREMRANGEBYSCORE(trim aged) + ZCARD. A `:live` marker tells
//      "seeded but empty" apart from "unseeded" so an empty mirror never
//      undercounts. wa-guard's newContactBudget stays the authoritative
//      per-send gate, so a stale mirror can never over-send.
//   2. CONCURRENT-CAMPAIGN COUNTER - a plain INCR/DECR per user, guarded by a
//      per-batch SET-NX marker (a retried batch job never double-INCRs) and a
//      6h EXPIRE (a leaked slot self-heals). Over-cap is a reported outcome,
//      not an error.
//
// Same contract as rival-cache.ts: the ONE shared `hotStateClient()` (REDIS_URL
// gated) - null on Vercel => every function is a no-op / returns null, and
// callers fall back to the Postgres budget path. NEVER throws.

import { hotStateClient } from "./rival-cache";

// ---------------------------------------------------------------------------
// Key schema - pure builders, exported for tests + the packages re-export.
// ---------------------------------------------------------------------------

export function introsKey(senderKey: string): string {
  return `budget:intros:${senderKey}`;
}
export function introsLiveKey(senderKey: string): string {
  return `budget:intros:${senderKey}:live`;
}
export function campaignSlotKey(userEmail: string): string {
  return `budget:campaigns:${userEmail}`;
}
export function campaignHeldKey(userEmail: string, batchId: string): string {
  return `budget:campaigns:${userEmail}:held:${batchId}`;
}
export function campaignKey(batchId: string): string {
  return `campaign:${batchId}`;
}

/** Slot markers live 6h - long enough to span a full ultra campaign's delayed
 * jobs, short enough that any leaked slot self-heals well before the next day. */
const SLOT_TTL_S = 6 * 3600;
/** Campaign progress hash survives long enough for the sync event + forensics. */
const CAMPAIGN_TTL_S = 48 * 3600;

function introTtlS(windowHours: number): number {
  return Math.max(1, Math.round(windowHours)) * 2 * 3600;
}

// ---------------------------------------------------------------------------
// 1. Intro-window mirror
// ---------------------------------------------------------------------------

/**
 * Distinct new-shop introductions this sender made inside the trailing window,
 * or null when the mirror is not authoritative (Redis off, or the window has
 * not been seeded yet). Callers treat null as "seed me / fall back to Postgres".
 * Fast path: trim members older than the window, then ZCARD.
 */
export async function introUsage(senderKey: string, windowHours: number): Promise<number | null> {
  const r = await hotStateClient();
  if (!r) return null;
  try {
    if ((await r.exists(introsLiveKey(senderKey))) !== 1) return null;
    const cutoff = Date.now() - Math.max(1, windowHours) * 3600_000;
    await r.zremrangebyscore(introsKey(senderKey), 0, cutoff);
    return await r.zcard(introsKey(senderKey));
  } catch {
    return null;
  }
}

/**
 * Seed the mirror from the authoritative Postgres window (called once, when
 * introUsage returned null but Redis is up). Overwrites any partial state and
 * sets the `:live` marker so subsequent reads use the fast path.
 */
export async function seedIntroWindow(
  senderKey: string,
  windowHours: number,
  entries: { toNumber: string; atMs: number }[]
): Promise<void> {
  const r = await hotStateClient();
  if (!r) return;
  try {
    const key = introsKey(senderKey);
    const ttl = introTtlS(windowHours);
    await r.del(key);
    for (const e of entries) {
      if (!e.toNumber || !Number.isFinite(e.atMs)) continue;
      await r.zadd(key, String(e.atMs), e.toNumber);
    }
    await r.expire(key, ttl);
    await r.set(introsLiveKey(senderKey), "1", "EX", ttl);
  } catch {
    /* a failed seed just means the next check re-seeds - never fatal */
  }
}

/**
 * Record a successful new-shop introduction (the ONE truth point - called from
 * the outbound worker after a real `kind==="rfq"` send lands). No-op when the
 * mirror is not seeded, so a cold mirror is never left partially populated: the
 * next batch seeds it fresh from Postgres, which already includes this send.
 */
export async function recordIntro(
  senderKey: string,
  toNumber: string,
  windowHours: number
): Promise<void> {
  const r = await hotStateClient();
  if (!r || !toNumber) return;
  try {
    if ((await r.exists(introsLiveKey(senderKey))) !== 1) return;
    const ttl = introTtlS(windowHours);
    await r.zadd(introsKey(senderKey), String(Date.now()), toNumber);
    await r.expire(introsKey(senderKey), ttl);
    await r.expire(introsLiveKey(senderKey), ttl);
  } catch {
    /* the mirror re-seeds from Postgres on the next check - never fatal */
  }
}

// ---------------------------------------------------------------------------
// 2. Concurrent-campaign gate
// ---------------------------------------------------------------------------

export type CampaignSlot =
  | { ok: true }
  | { ok: false; active: number; cap: number };

/**
 * Try to claim one concurrent-campaign slot for this user. Returns:
 *   - null  => Redis off: caller FAILS OPEN (the send-time guard still bounds
 *              every message; claimInboundIds precedent).
 *   - {ok:true}  => slot granted (or this is a retry replay - already counted).
 *   - {ok:false, active, cap} => at capacity; caller reports & rejects the batch.
 * Idempotent per batchId via a SET-NX marker, so a retried batch job can never
 * double-INCR. The counter carries a 6h EXPIRE so a leaked slot self-heals.
 */
export async function tryAcquireCampaignSlot(
  userEmail: string,
  batchId: string,
  cap: number
): Promise<CampaignSlot | null> {
  const r = await hotStateClient();
  if (!r) return null;
  try {
    const held = campaignHeldKey(userEmail, batchId);
    const marked = await r.set(held, "1", "EX", SLOT_TTL_S, "NX");
    if (!marked) return { ok: true }; // already counted (retry replay)
    const slot = campaignSlotKey(userEmail);
    const active = await r.incr(slot);
    await r.expire(slot, SLOT_TTL_S);
    if (active > Math.max(1, cap)) {
      await r.decr(slot);
      await r.del(held);
      return { ok: false, active: active - 1, cap: Math.max(1, cap) };
    }
    return { ok: true };
  } catch {
    return null; // fail open on a Redis hiccup
  }
}

/**
 * Release a campaign slot on terminal outcome (sync handler). Marker-guarded so
 * a double-release is a no-op, and floored at 0 so the counter can never drift
 * negative and permanently block a user.
 */
export async function releaseCampaignSlot(userEmail: string, batchId: string): Promise<void> {
  const r = await hotStateClient();
  if (!r) return;
  try {
    const held = campaignHeldKey(userEmail, batchId);
    const removed = await r.del(held);
    if (removed !== 1) return; // never held / already released
    const slot = campaignSlotKey(userEmail);
    const active = await r.decr(slot);
    if (active < 0) await r.del(slot);
  } catch {
    /* the 6h TTL self-heals a stuck counter regardless */
  }
}

// ---------------------------------------------------------------------------
// 3. Campaign progress hash - the sync source of truth
// ---------------------------------------------------------------------------

export type CampaignState = "running" | "completed" | "rejected" | "failed";

export interface CampaignInit {
  userEmail: string;
  plan: string;
  total: number;
  skipped: number;
}

/** Initialise the progress hash for a fanned-out batch (pending = total). */
export async function initCampaign(batchId: string, f: CampaignInit): Promise<void> {
  const r = await hotStateClient();
  if (!r) return;
  try {
    const key = campaignKey(batchId);
    await r.hset(
      key,
      "userEmail", f.userEmail,
      "plan", f.plan,
      "total", String(f.total),
      "pending", String(f.total),
      "dispatched", "0",
      "failed", "0",
      "skipped", String(f.skipped),
      "state", "running",
      "createdAt", new Date().toISOString()
    );
    await r.expire(key, CAMPAIGN_TTL_S);
  } catch {
    /* the hash is an observability + sync convenience, never the send truth */
  }
}

/** Increment a running tally on the campaign hash. */
export async function bumpCampaign(
  batchId: string,
  field: "dispatched" | "failed" | "skipped",
  n = 1
): Promise<void> {
  const r = await hotStateClient();
  if (!r) return;
  try {
    await r.hincrby(campaignKey(batchId), field, n);
  } catch {
    /* tally drift is cosmetic - whatsapp_messages remains the send record */
  }
}

/**
 * Decrement the pending counter for one terminal vendor-job outcome and return
 * the remaining count (null when Redis off). The caller fires the completion
 * sync ONLY on a strict `=== 0`, so a crash-replayed job that drives pending
 * negative simply skips instead of double-firing.
 */
export async function completeVendorJob(batchId: string): Promise<number | null> {
  const r = await hotStateClient();
  if (!r) return null;
  try {
    return await r.hincrby(campaignKey(batchId), "pending", -1);
  } catch {
    return null;
  }
}

/** Set the campaign's terminal (or transitional) state. */
export async function setCampaignState(batchId: string, state: CampaignState): Promise<void> {
  const r = await hotStateClient();
  if (!r) return;
  try {
    await r.hset(campaignKey(batchId), "state", state);
    await r.expire(campaignKey(batchId), CAMPAIGN_TTL_S);
  } catch {
    /* non-fatal */
  }
}

/** Read the campaign hash for the sync write ({} when absent/unavailable). */
export async function readCampaign(batchId: string): Promise<Record<string, string>> {
  const r = await hotStateClient();
  if (!r) return {};
  try {
    return await r.hgetall(campaignKey(batchId));
  } catch {
    return {};
  }
}
