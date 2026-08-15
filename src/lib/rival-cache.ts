// SESSION OFFER HOT STATE (Module 2 of the GCP migration).
//
// The lowest-rival read used to be a Postgres query on every negotiation turn;
// on the VM it becomes an O(log n) Redis ZSET read, and the dashboard's
// OFFERS IN / BARGAINED tiles become an HSET the SSE stream pushes instantly.
//
// This file is the CANONICAL implementation (the "brain in src/lib, packages
// re-export" pattern - @wheeldeal/redis/offers re-exports from here) because
// the same code runs in BOTH runtimes during the dual-run:
//   - With no REDIS_URL: every function is an instant no-op /
//     null. Zero behavior change, zero connection attempts, build unaffected.
//   - On the VM (workers/gateway): REDIS_URL is set -> full hot path.
//
// DUAL-RUN CORRECTNESS RULE: Redis is authoritative ONLY for sessions whose
// offers were written through the worker path. The first worker-side write
// sets a `live` flag; the cached-rival read returns null unless that flag
// exists, so a keyless-era session can never read a stale or incomplete cache
// - it silently falls through to the Postgres path.
//
// Never throws: a Redis hiccup degrades to "no cache" (callers fall back).

export type RedisLike = {
  /**
   * The cheapest possible proof of life. Optional on the TYPE (the test doubles
   * in daily-cap-atomic.test.ts and budget-cache.test.ts implement only the
   * commands they exercise), required in practice - ioredis has it - so the
   * admin probe checks for it before calling rather than assuming.
   */
  ping?(): Promise<string>;
  set(...args: (string | number)[]): Promise<unknown>;
  exists(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  zadd(key: string, score: string, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number, withScores?: "WITHSCORES"): Promise<string[]>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<unknown>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<unknown>;
  zcard(key: string): Promise<number>;
  hset(key: string, ...fieldValues: (string | number)[]): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

let client: RedisLike | null | undefined; // undefined = not tried, null = unavailable

/** The shared lazy, REDIS_URL-gated hot-state client - null when REDIS_URL is unset /
 * Redis is down. Exported so sibling hot-state modules (the copy-uniqueness
 * signature window) reuse ONE connection instead of opening their own. */
export async function hotStateClient(): Promise<RedisLike | null> {
  return cacheClient();
}

async function cacheClient(): Promise<RedisLike | null> {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  try {
    const { default: Redis } = await import("ioredis");
    const c = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      commandTimeout: 2000,
      lazyConnect: false,
    });
    c.on("error", () => {}); // degrade silently; callers fall back to Postgres
    client = c as unknown as RedisLike;
  } catch {
    client = null;
  }
  return client;
}

/**
 * IS THE HOT-STATE TIER ACTUALLY THERE? (Wave 7)
 *
 * Redis is a real dependency of four subsystems - the atomic daily caps
 * (`usage.ts`), the AI budget cache, the copy-uniqueness window and the SSE
 * session fan-out - and it was the ONE dependency with no surface anywhere:
 * not on the Keys page, not in the health roll-call, not in a probe. That
 * matters more than a missing tile, because `REDIS_URL` is the documented
 * difference between an ATOMIC daily cap and a per-process counter that
 * `--max-instances 20` multiplies by twenty. "Nothing is enforcing the cap"
 * and "everything is fine" looked identical.
 *
 * Three states, and they are genuinely different:
 *   off  - REDIS_URL unset. Not a fault; it is the documented degraded mode,
 *          and the detail says exactly what that costs.
 *   ok   - a real PING round-tripped, with the milliseconds it took.
 *   down - configured and NOT answering, which is the state where the caps
 *          silently fall back to per-process counting.
 */
export async function redisDiagnostics(): Promise<{
  configured: boolean;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}> {
  if (!process.env.REDIS_URL) {
    return {
      configured: false,
      ok: false,
      latencyMs: null,
      detail:
        "REDIS_URL is not set. Daily AI/send caps fall back to a per-process counter, so with --max-instances 20 each cap can be exceeded up to 20x. Session hot state and the copy-uniqueness window are no-ops.",
    };
  }
  const r = await cacheClient();
  if (!r || typeof r.ping !== "function") {
    return {
      configured: true,
      ok: false,
      latencyMs: null,
      detail: "REDIS_URL is set but no client could be created - check the URL and that ioredis can reach it.",
    };
  }
  const t0 = Date.now();
  try {
    const pong = await r.ping();
    const ms = Date.now() - t0;
    return {
      configured: true,
      ok: String(pong).toUpperCase() === "PONG",
      latencyMs: ms,
      detail:
        String(pong).toUpperCase() === "PONG"
          ? `PONG in ${ms}ms - atomic caps and session hot state are live.`
          : `Unexpected reply to PING: ${String(pong).slice(0, 40)}`,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - t0,
      detail: `PING failed: ${e instanceof Error ? e.message : "unreachable"}. The atomic caps are silently back to per-process counting.`,
    };
  }
}

const TTL_S = 24 * 3600;

// ---------------------------------------------------------------------------
// Key schema - pure builders, exported for tests and the packages re-export.
// The offers ZSET is scoped by vehicleKey + currency so a rival can NEVER
// cross vehicle classes or currencies (mirrors pickCheapestRival's rules).
// ---------------------------------------------------------------------------

export function offersKey(searchId: string | number, vehicleKey: string, currency: string): string {
  return `session:${searchId}:${vehicleKey}:${currency}:offers`;
}
export function listPriceKey(searchId: string | number, vehicleKey: string, currency: string): string {
  return `session:${searchId}:${vehicleKey}:${currency}:list`;
}
export function aggKey(searchId: string | number): string {
  return `session:${searchId}:agg`;
}
export function liveFlagKey(searchId: string | number): string {
  return `session:${searchId}:live`;
}
export function eventsChannel(searchId: string | number): string {
  return `session:${searchId}:events`;
}

export interface SessionOfferWrite {
  searchId: string | number;
  vendorId: string;
  vehicleKey: string;
  currency: string;
  /** The shop's CURRENT per-day price (latest round). */
  pricePerDay: number;
  /** The FIRST quote - savings anchor. Only set on the first write per vendor. */
  listPricePerDay: number;
  durationDays: number;
}

export interface SessionEventPayload {
  type: "offer" | "counter" | "state" | "message";
  vendorId?: string;
  pricePerDay?: number;
  at: string;
  detail?: string;
}

/** Publish a delta on the session channel (SSE fan-out subscribes). No-op when REDIS_URL is unset. */
export async function publishSessionEvent(
  searchId: string | number,
  event: SessionEventPayload
): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  try {
    await r.publish(eventsChannel(searchId), JSON.stringify(event));
  } catch {
    /* realtime is an enhancement - polling remains the fallback */
  }
}

/**
 * Record/refresh a shop's offer for a search session and recompute the
 * dashboard aggregates. Sets the `live` authority flag (worker-side writes
 * only reach here - a no-op when unset). BARGAINED mirrors the UI's truthful
 * calc: sum of max(0, list - current) * durationDays across vendors.
 */
export async function recordSessionOffer(w: SessionOfferWrite): Promise<void> {
  const r = await cacheClient();
  if (!r) return;
  try {
    const oKey = offersKey(w.searchId, w.vehicleKey, w.currency);
    const lKey = listPriceKey(w.searchId, w.vehicleKey, w.currency);
    await r.zadd(oKey, String(w.pricePerDay), w.vendorId);
    // List price = FIRST quote only (NX semantics via manual exists check on
    // the hash field is racy; HSETNX isn't in our minimal type - read+set is
    // fine here because only ONE worker turn per thread runs at a time).
    const lists = await r.hgetall(lKey);
    if (!(w.vendorId in lists)) {
      await r.hset(lKey, w.vendorId, String(w.listPricePerDay));
      lists[w.vendorId] = String(w.listPricePerDay);
    }
    await r.set(liveFlagKey(w.searchId), "1", "EX", TTL_S);
    await r.expire(oKey, TTL_S);
    await r.expire(lKey, TTL_S);

    // Recompute aggregates from the full ZSET (cheap: a session holds <50 shops).
    const rows = await r.zrange(oKey, 0, -1, "WITHSCORES");
    let offersIn = 0;
    let bargained = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rows.length; i += 2) {
      const vendorId = rows[i];
      const current = Number(rows[i + 1]);
      if (!Number.isFinite(current)) continue;
      offersIn += 1;
      if (current < best) best = current;
      const list = Number(lists[vendorId] ?? current);
      if (Number.isFinite(list) && list > current) {
        bargained += Math.max(0, list - current) * Math.max(1, w.durationDays);
      }
    }
    const agg = aggKey(w.searchId);
    await r.hset(
      agg,
      "offersIn", String(offersIn),
      "bargained", String(Math.round(bargained)),
      "bestPricePerDay", Number.isFinite(best) ? String(best) : "",
      "currency", w.currency,
      "updatedAt", new Date().toISOString()
    );
    await r.expire(agg, TTL_S);

    await publishSessionEvent(w.searchId, {
      type: "offer",
      vendorId: w.vendorId,
      pricePerDay: w.pricePerDay,
      at: new Date().toISOString(),
    });
  } catch {
    /* cache write failure never breaks the turn - Postgres stays the truth */
  }
}

export interface CachedRivalQuery {
  searchId: string | number;
  vehicleKey: string;
  currency: string;
  excludeVendorId: string;
  /** Only a rival STRICTLY cheaper than this quote is leverage. */
  belowPrice: number;
}

/**
 * The cheapest OTHER shop's live offer for this exact session/vehicle/currency,
 * or null. Null also when: no REDIS_URL, the session isn't flagged
 * `live` (legacy session - cache not authoritative), or Redis is down.
 * Callers ALWAYS fall back to the Postgres path on null.
 */
export async function cheapestCachedRival(q: CachedRivalQuery): Promise<number | null> {
  const r = await cacheClient();
  if (!r) return null;
  try {
    if ((await r.exists(liveFlagKey(q.searchId))) !== 1) return null;
    const rows = await r.zrange(offersKey(q.searchId, q.vehicleKey, q.currency), 0, 9, "WITHSCORES");
    for (let i = 0; i < rows.length; i += 2) {
      if (rows[i] === q.excludeVendorId) continue;
      const price = Number(rows[i + 1]);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (price >= q.belowPrice) return null; // sorted ascending - no cheaper rival exists
      return price;
    }
    return null;
  } catch {
    return null;
  }
}

/** Current dashboard aggregates for a session ({} when absent/unavailable). */
export async function sessionAggregates(
  searchId: string | number
): Promise<Record<string, string>> {
  const r = await cacheClient();
  if (!r) return {};
  try {
    return await r.hgetall(aggKey(searchId));
  } catch {
    return {};
  }
}
