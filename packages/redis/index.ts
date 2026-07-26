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

// Multi-image-per-turn coalescing (Module 4.1) - worker-path burst buffer.
export {
  beginImageWindow,
  drainImageWindow,
  imageWindowKey,
  imageBufferKey,
  IMAGE_WINDOW_SECONDS,
} from "./image-buffer";
export type { ImageWindowStart } from "./image-buffer";

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

// Every SSE client attaches a listener to the ONE shared subscriber connection,
// so two things need care:
//
//  1. REFCOUNTING. The unsubscribe used to be unconditional: with two viewers on
//     the same search, the first one to close called `unsubscribe(chan)` and
//     silently killed live updates for the other, who then sat on a connection
//     that would never emit again. We now only leave the channel when the last
//     listener for it goes.
//  2. LISTENER CEILING. Node warns (and leaks are masked) past 10 listeners on
//     one emitter; a handful of concurrent viewers is completely normal here.
const chanRefs = new Map<string, number>();

export function subscribeSessionEvents(
  searchId: string | number,
  onEvent: (e: SessionEvent) => void
): () => void {
  const chan = chanFor(searchId);
  const sub = redisSubscriber();
  // Headroom for concurrent viewers; the real leak guard is the cleanup below.
  if (typeof sub.setMaxListeners === "function") sub.setMaxListeners(200);

  const handler = (channel: string, message: string) => {
    if (channel !== chan) return;
    try {
      onEvent(JSON.parse(message) as SessionEvent);
    } catch {
      /* malformed event - skip */
    }
  };

  const refs = (chanRefs.get(chan) ?? 0) + 1;
  chanRefs.set(chan, refs);
  // Only the FIRST subscriber issues SUBSCRIBE; the rest just add a listener.
  if (refs === 1) sub.subscribe(chan).catch(() => {});
  sub.on("message", handler);

  let released = false;
  return () => {
    // Idempotent: a double-close (req close + res error both firing) must not
    // drive the refcount negative and unsubscribe a channel others still use.
    if (released) return;
    released = true;
    sub.off("message", handler);
    const left = (chanRefs.get(chan) ?? 1) - 1;
    if (left <= 0) {
      chanRefs.delete(chan);
      sub.unsubscribe(chan).catch(() => {});
    } else {
      chanRefs.set(chan, left);
    }
  };
}
