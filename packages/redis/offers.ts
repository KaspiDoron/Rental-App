// @wheeldeal/redis/offers - session offer hot state for the services.
//
// The CANONICAL implementation lives in src/lib/rival-cache.ts (the "brain in
// src/lib, packages re-export" pattern) because the same code must run in both
// runtimes during the dual-run: REDIS_URL-gated no-ops when unset, the full
// ZSET/HSET/pub-sub hot path on the VM. Services import from HERE so the
// physical relocation later is a path change, not a rewrite.

export {
  // key builders (pure - shared schema, unit-tested)
  offersKey,
  listPriceKey,
  aggKey,
  liveFlagKey,
  eventsChannel,
  // writes
  recordSessionOffer,
  publishSessionEvent,
  // reads
  cheapestCachedRival,
  sessionAggregates,
} from "../../src/lib/rival-cache";

export type {
  SessionOfferWrite,
  CachedRivalQuery,
  SessionEventPayload,
} from "../../src/lib/rival-cache";
