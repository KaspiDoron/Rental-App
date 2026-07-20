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
// Session offer hot state (Module 2) - canonical impl in src/lib/rival-cache,
// re-exported via ./offers (one schema, both runtimes).
// ---------------------------------------------------------------------------

export {
  recordSessionOffer,
  cheapestCachedRival,
  publishSessionEvent,
  sessionAggregates,
  offersKey,
  listPriceKey,
  aggKey,
  liveFlagKey,
  eventsChannel,
} from "./offers";
export type { SessionOfferWrite, CachedRivalQuery, SessionEventPayload } from "./offers";

// ---------------------------------------------------------------------------
// Plan-tier outreach budgets (Module 6) - canonical impl in src/lib/budget-
// cache, re-exported via ./budgets (one schema, both runtimes).
// ---------------------------------------------------------------------------

export {
  introUsage,
  seedIntroWindow,
  recordIntro,
  tryAcquireCampaignSlot,
  releaseCampaignSlot,
  initCampaign,
  bumpCampaign,
  completeVendorJob,
  setCampaignState,
  readCampaign,
  introsKey,
  introsLiveKey,
  campaignSlotKey,
  campaignHeldKey,
  campaignKey,
} from "./budgets";
export type { CampaignSlot, CampaignState, CampaignInit } from "./budgets";

// ---------------------------------------------------------------------------
// Pub/sub SUBSCRIBE side - services only (a subscribed conn can't run
// commands, so this stays on the always-on service client).
// ---------------------------------------------------------------------------

import { eventsChannel as chanFor } from "./offers";
import type { SessionEventPayload as SessionEvent } from "./offers";

export function subscribeSessionEvents(
  searchId: string | number,
  onEvent: (e: SessionEvent) => void
): () => void {
  const chan = chanFor(searchId);
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
