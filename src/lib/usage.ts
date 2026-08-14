// API cost guard - tracking, caching and abuse limits for every paid/quota'd
// external call (Google Maps, AI tokens, WhatsApp sends).
//
// Goals: never waste a request (caching), track every call durably
// (api_usage), enforce per-user daily limits (configurable by the owner in
// Admin -> Limits), and a global KILL SWITCH that halts all paid services.

import "server-only";
import {
  getConfig,
  getConfigFresh,
  sbInsert,
  sbSelect,
  sbSelectStrict,
} from "./runtime-config";
import { boundedSet } from "./bounded-map";
// Static, like budget-cache.ts: rival-cache has no top-level side effects and
// only reaches for `ioredis` lazily, once, when REDIS_URL is actually set.
import { hotStateClient } from "./rival-cache";

// Free monthly quotas we track against (shown in the cost tracker).
export const QUOTAS: Record<string, { free: number; label: string; unitCost: number }> = {
  places_search: { free: 5000, label: "Google Places searches", unitCost: 0.032 },
  place_details: { free: 5000, label: "Google Place details", unitCost: 0.017 },
  geocoding: { free: 10000, label: "Google Geocoding", unitCost: 0.005 },
  photo: { free: 5000, label: "Google photos", unitCost: 0.007 },
};

// ---- kill switch ---------------------------------------------------------------

/**
 * THE SWITCH THAT TURNED ITSELF OFF.
 *
 * This was `(await getConfig("KILL_SWITCH")) === "1"`. During a Supabase
 * brownout loadOverrides returns {} and KILL_SWITCH is not in the deploy env
 * list, so the expression is `undefined === "1"` -> **false**: the emergency
 * stop disengaged itself precisely when the system was least healthy. The same
 * wobble simultaneously zeroed the daily caps and both anti-ban budgets (see
 * below and evolution.ts), so the convergent state was every safety system off
 * at once - the configuration that gets a traveller's personal number banned.
 *
 * So: unreadable means KILLED. A false stop costs a paused search; a false
 * "running" costs someone their WhatsApp account.
 *
 * `error: "missing"` is NOT reachable here - getConfigFresh escalates only when
 * the vault genuinely could not be read, never when Supabase is simply not
 * configured (demo mode) or the key is honestly unset.
 *
 * AND IT HAS TO STOP THINGS PROMPTLY. This read `getConfigStrict`, which goes
 * through the 30s whole-vault cache - so pulling the handle left every warm
 * instance sending, spending and charging for up to thirty more seconds.
 * `getConfigFresh` has the SAME error semantics (that is the part that must not
 * change) but reads this one row by exact key on a 3s window, so the stop
 * arrives in seconds. Concurrent callers share one in-flight read, so the cost
 * is one small query per instance per 3s no matter how many sends are running.
 */
export async function killSwitchOn(): Promise<boolean> {
  const r = await getConfigFresh("KILL_SWITCH");
  if ("error" in r) return true;
  return r.value === "1";
}

// ---- durable usage log -----------------------------------------------------------

export async function recordApi(kind: string, count = 1, userEmail?: string) {
  await sbInsert("api_usage", [
    { kind, count, user_email: userEmail ?? null },
  ]).catch(() => {});
}

/** Today's total for one usage kind (UTC day). Used by the Whisper meter. */
export async function usageTodayFor(kind: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await sbSelect<{ count: number }>(
    "api_usage",
    `select=count&kind=eq.${encodeURIComponent(kind)}&created_at=gte.${encodeURIComponent(
      start.toISOString()
    )}&limit=10000`
  ).catch(() => []);
  return rows.reduce((n, r) => n + (r.count ?? 1), 0);
}

// Groq Whisper's free tier is a GLOBAL ~2k requests/day, shared across the
// whole fleet (owner report 4, scale #5) - not a per-user cap. Past 80% we
// stop spending the last of it on new transcriptions and let Gemini audio
// carry them, so the cheap-but-scarce rung is not exhausted by mid-afternoon.
export const WHISPER_DAILY_CAP = 2_000;
export const WHISPER_SOFT_FRACTION = 0.8;

/** True when today's Groq-Whisper use is at/over 80% of the daily cap. */
export async function whisperOverSoftCap(): Promise<boolean> {
  const used = await usageTodayFor("groq_whisper");
  return used >= WHISPER_DAILY_CAP * WHISPER_SOFT_FRACTION;
}

/** Usage this calendar month per kind (for the cost tracker). */
export async function monthlyUsage(): Promise<Record<string, number>> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await sbSelect<{ kind: string; count: number }>(
    "api_usage",
    `select=kind,count&created_at=gte.${encodeURIComponent(start.toISOString())}&limit=10000`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + (r.count ?? 1);
  return out;
}

// ---- per-user daily limits (owner-configurable) -----------------------------------

export const LIMIT_DEFAULTS: Record<string, number> = {
  LIMIT_SEARCHES_PER_DAY: 15, // vendor discovery (Places searches)
  // Address lookups: every debounced keystroke pause is one call, so 40/day
  // made the dropdown go silently empty mid-trip. Autocomplete + session
  // tokens are the cheap SKU - 300 keeps typing fluid while still bounded.
  LIMIT_GEOCODE_PER_DAY: 300,
  LIMIT_AI_PER_DAY: 120, // AI calls (extraction, drafts, translate sweeps)
  LIMIT_TRANSLATE_PER_DAY: 60, // UI translate sweeps (cache means most are free)
  // TWO LANES, NOT ONE POOL.
  //
  // LIMIT_WA_PER_HOUR = 15 was a SINGLE pool shared by cold introductions and
  // negotiation replies, enforced on the one send path with no kind filter. A
  // 24-shop batch therefore consumed the entire hourly allowance at shop 15,
  // and every agent reply to a shop that answered inside that hour was refused
  // with "Hourly safety cap reached". The batch starved its own negotiation,
  // which is self-defeating: a reply is the one thing that clears the
  // unanswered-thread counter WhatsApp actually meters.
  //
  // The intro lane is the risk-bearing one and stays tight. The reply lane is
  // reciprocal traffic - the SAFE side of the documented axis - and is sized so
  // a full batch's answers can never be blocked by the batch that caused them.
  //
  // The daily intro ceiling is deliberately NOT raised to 220. That would be
  // ~6,600 a month against the only monthly ceiling anyone has reported
  // (~1,000), which is not a ceiling at all.
  LIMIT_WA_INTRO_PER_HOUR: 24, // matches the 24-shop day-one ceiling
  LIMIT_WA_INTRO_PER_DAY: 80,
  LIMIT_WA_REPLY_PER_HOUR: 40,
  LIMIT_WA_REPLY_PER_DAY: 200,

  // Legacy names, kept so an existing Key Vault override does not silently
  // vanish. Nothing reads them any more - the two lanes above are the
  // authority - but a value pasted here should still be visible to the owner.
  LIMIT_WA_PER_HOUR: 15,
  LIMIT_WA_PER_DAY: 60,
};

export async function limitFor(name: keyof typeof LIMIT_DEFAULTS): Promise<number> {
  const v = Number(await getConfig(name));
  const base = Number.isFinite(v) && v > 0 ? v : LIMIT_DEFAULTS[name];
  // SCALE_MODE: one owner switch that triples every per-user budget when the
  // backend plans have been upgraded to carry the load. Explicit per-limit
  // overrides above still win (they are read first).
  try {
    const scale = ((await getConfig("SCALE_MODE")) ?? "").trim().toLowerCase();
    if (scale === "on" || scale === "1" || scale === "true") return base * 3;
  } catch {
    /* scale lookup is best-effort */
  }
  return base;
}

export function limitDefaults() {
  return { ...LIMIT_DEFAULTS };
}

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_limits__: Map<string, { day: string; n: number }> | undefined;
}

function counters() {
  if (!globalThis.__wheeldeal_limits__) globalThis.__wheeldeal_limits__ = new Map();
  return globalThis.__wheeldeal_limits__;
}

// ---- atomic daily reservation (Redis) ------------------------------------------

/**
 * A CAP YOU CAN WALK THROUGH IS NOT A CAP.
 *
 * `checkDailyLimit` READS a count and returns; the debit is a separate
 * `recordApi` call at a different point in the code (there were ten of those
 * against five of these, so they were not even paired). Between the read and
 * the write, every concurrent request sees the same pre-debit number - so a
 * user exceeds any cap by the parallelism factor. For an AI cap that is a bill;
 * for the WhatsApp volume caps it is a banned personal number.
 *
 * INCR is atomic, so concurrent callers get DISTINCT totals and exactly one can
 * be the one that crosses the line. Over-cap gives the unit straight back, so a
 * refused request does not inflate the counter permanently.
 *
 * SAME DISCIPLINE AS budget-cache.ts: Redis is a gate that can only ever refuse
 * MORE, never permit more, and Postgres stays the durable record. That makes
 * this strictly a tightening - it cannot introduce a new way to over-send.
 *
 * WITHOUT REDIS THIS IS A NO-OP, and the read-then-write window is exactly as
 * wide as it has always been. That is stated here rather than hidden: a
 * deployment with no REDIS_URL has NOT had this defect fixed.
 */
async function reserveDailyUnit(
  kind: string,
  who: string,
  limit: number
): Promise<"ok" | "over" | "unavailable"> {
  try {
    const r = await hotStateClient();
    if (!r) return "unavailable";
    const day = new Date().toISOString().slice(0, 10);
    const key = `usage:${kind}:${who}:${day}`;
    const n = await r.incr(key);
    // Only on the first increment of the day, so the window cannot be pushed
    // forward by later traffic. 26h covers any timezone skew in the day key.
    if (n === 1) await r.expire(key, 26 * 3600);
    if (n > Math.max(1, limit)) {
      // Hand it back - a refusal must not consume allowance, or a burst of
      // refused requests would lock the user out for the rest of the day.
      await r.decr(key).catch(() => 0);
      return "over";
    }
    return "ok";
  } catch {
    // A Redis hiccup degrades to the Postgres-only path, never to a refusal.
    return "unavailable";
  }
}

/**
 * Reserve ONE unit atomically, for callers that spend in units rather than in
 * requests (the AI budget scope reserves per model call). Returns false only
 * when Redis says the cap is already met - never on an outage, which degrades
 * to the caller's own local accounting.
 */
export async function reserveDailyUnitFor(
  kind: string,
  who: string,
  limit: number
): Promise<boolean> {
  return (await reserveDailyUnit(kind, who, limit)) !== "over";
}

/**
 * Count one use against a per-user daily limit. Uses the durable api_usage log
 * (accurate across serverless instances) with an in-memory fast path.
 */
export async function checkDailyLimit(
  kind: string,
  who: string,
  limitName: keyof typeof LIMIT_DEFAULTS,
  /**
   * `reserve: false` PEEKS instead of consuming a unit. Used by callers that do
   * their own per-unit reservation later (the AI budget scope reserves once per
   * model call, so a peek here plus a reserve there would double-count).
   */
  opts?: { reserve?: boolean }
): Promise<{ allowed: boolean; used: number; limit: number; reason?: string }> {
  const limit = await limitFor(limitName);
  const today = new Date().toISOString().slice(0, 10);
  const key = `${kind}:${who}`;
  const mem = counters().get(key);
  if (mem?.day === today && mem.n >= limit) {
    return { allowed: false, used: mem.n, limit };
  }
  // FAIL CLOSED ON UNREADABLE, FAIL OPEN ON NOT-MIGRATED.
  //
  // This was sbSelect, which collapses every failure to [] - so `used` reduced
  // to 0 and EVERY per-user daily cap allowed for the whole duration of a
  // Supabase wobble. The two error shapes point in opposite directions: a table
  // that has never existed is vacuously empty and must not brick a fresh
  // install, while a table that could not be read means the count is UNKNOWN
  // and spending someone's paid quota on a guess is not ours to do.
  const read = await sbSelectStrict<{ count: number }>(
    "api_usage",
    `select=count&kind=eq.${encodeURIComponent(kind)}&user_email=eq.${encodeURIComponent(
      who
    )}&created_at=gte.${encodeURIComponent(today)}&limit=1000`
  );
  if ("error" in read && read.error === "unavailable") {
    return {
      allowed: false,
      used: 0,
      limit,
      reason: "unreadable",
    };
  }
  const rows = "rows" in read ? read.rows : [];
  const used = rows.reduce((s, r) => s + (r.count ?? 1), 0);
  // Bounded (like the sibling apiCache) so the map can't grow one entry per
  // distinct user*kind forever on a long-lived process.
  boundedSet(counters(), key, { day: today, n: Math.max(used, mem?.day === today ? mem.n : 0) }, 5000);
  if (used >= limit) return { allowed: false, used, limit };

  // THE POSTGRES READ CANNOT SEE A CONCURRENT BURST - it is a snapshot taken
  // before anyone debits. The atomic reservation below is what actually makes
  // the cap hold under parallelism; the read above is what makes it hold across
  // instances and restarts. Both are needed, and the reservation can only ever
  // refuse MORE than the read would.
  if (opts?.reserve !== false) {
    const reserved = await reserveDailyUnit(kind, who, limit);
    if (reserved === "over") {
      return { allowed: false, used: limit, limit, reason: "concurrent" };
    }
  }

  const cur = counters().get(key)!;
  cur.n += 1;
  return { allowed: true, used: used + 1, limit };
}

// ---- request caching (saves real money) --------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_apicache__: Map<string, { exp: number; data: unknown }> | undefined;
}

function apiCache() {
  if (!globalThis.__wheeldeal_apicache__) globalThis.__wheeldeal_apicache__ = new Map();
  return globalThis.__wheeldeal_apicache__;
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = apiCache().get(key);
  if (hit && hit.exp > Date.now()) return hit.data as T;
  return undefined;
}

export function cacheSet(key: string, data: unknown, ttlMs: number) {
  const c = apiCache();
  if (c.size > 500) c.clear();
  c.set(key, { exp: Date.now() + ttlMs, data });
}
