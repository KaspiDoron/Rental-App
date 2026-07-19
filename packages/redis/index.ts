// @wheeldeal/redis - shared ioredis clients + the hot-state helpers the
// migration blueprint assigns to Redis: ingress idempotency, session offer
// aggregates (lowest rival in O(log n)), and pub/sub for instant UI sync.

import Redis from "ioredis";
import { logger, redisUrl } from "../shared";

let client: Redis | null = null;
let subscriber: Redis | null = null;

/** Lazy shared connection (commands). BullMQ makes its own via bullConnection(). */
export function redis(): Redis {
  if (!client) {
    client = new Redis(redisUrl(), { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on("error", (e) => logger.error({ err: e.message }, "redis error"));
  }
  return client;
}

/** Dedicated subscriber connection (a subscribed client can't run commands). */
export function redisSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(redisUrl(), { maxRetriesPerRequest: 2 });
    subscriber.on("error", (e) => logger.error({ err: e.message }, "redis sub error"));
  }
  return subscriber;
}

/** BullMQ requires maxRetriesPerRequest:null on its blocking connections. */
export function bullConnection(): Redis {
  const c = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  c.on("error", (e) => logger.error({ err: e.message }, "redis bull error"));
  return c;
}

// ---------------------------------------------------------------------------
// Ingress idempotency - layer 1 of 3 (SETNX here, BullMQ jobId, DB claim).
// ---------------------------------------------------------------------------

/**
 * Claim a set of provider message ids at the webhook edge. Returns true when
 * at least one id is NEW (so the payload should be enqueued) or when there are
 * no ids at all (non-message events always pass through). 24h TTL.
 * FAILS OPEN: if Redis is unreachable we enqueue anyway - the worker's DB
 * claim still dedups, and a dropped shop reply is worse than a re-check.
 */
export async function claimInboundIds(ids: string[]): Promise<boolean> {
  const real = ids.filter(Boolean);
  if (real.length === 0) return true;
  try {
    const r = redis();
    let anyNew = false;
    for (const id of real) {
      const set = await r.set(`wa:msg:${id}`, "1", "EX", 86_400, "NX");
      if (set === "OK") anyNew = true;
    }
    return anyNew;
  } catch {
    return true; // fail open - downstream layers still dedup
  }
}

// ---------------------------------------------------------------------------
// Session offer aggregates (Module 2) - the instant-rival hot path.
// ---------------------------------------------------------------------------

const SESSION_TTL_S = 24 * 3600;

/** Record/refresh a shop's current per-day offer for a search session. */
export async function recordSessionOffer(
  searchId: string | number,
  vendorId: string,
  pricePerDay: number
): Promise<void> {
  const key = `session:${searchId}:offers`;
  const r = redis();
  await r.zadd(key, String(pricePerDay), vendorId);
  await r.expire(key, SESSION_TTL_S);
}

/** The cheapest OTHER shop's offer in this session, or null. */
export async function cheapestSessionRival(
  searchId: string | number,
  excludeVendorId: string
): Promise<{ vendorId: string; pricePerDay: number } | null> {
  const rows = await redis().zrange(`session:${searchId}:offers`, 0, 5, "WITHSCORES");
  for (let i = 0; i < rows.length; i += 2) {
    if (rows[i] !== excludeVendorId) {
      return { vendorId: rows[i], pricePerDay: Number(rows[i + 1]) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pub/sub - realtime UI sync (SSE fan-out subscribes to these).
// ---------------------------------------------------------------------------

export type SessionEvent = {
  type: "offer" | "counter" | "state" | "message";
  vendorId?: string;
  pricePerDay?: number;
  at: string;
  detail?: string;
};

export async function publishSessionEvent(
  searchId: string | number,
  event: SessionEvent
): Promise<void> {
  try {
    await redis().publish(`session:${searchId}:events`, JSON.stringify(event));
  } catch {
    /* realtime is an enhancement - polling remains the fallback */
  }
}

export function subscribeSessionEvents(
  searchId: string | number,
  onEvent: (e: SessionEvent) => void
): () => void {
  const chan = `session:${searchId}:events`;
  const sub = redisSubscriber();
  const handler = (channel: string, message: string) => {
    if (channel !== chan) return;
    try {
      onEvent(JSON.parse(message) as SessionEvent);
    } catch {
      /* malformed event - skip */
    }
  };
  sub.subscribe(chan).catch(() => {});
  sub.on("message", handler);
  return () => {
    sub.off("message", handler);
    sub.unsubscribe(chan).catch(() => {});
  };
}
