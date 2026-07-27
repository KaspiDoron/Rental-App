// MONOTONIC VERSIONED STATE: a value the client can only ever move FORWARD.
//
// The failure this exists for: tapping Resume flipped the switch to "Agents
// active" and then, a few seconds later, it flipped back to "paused" on its own.
// Nothing had re-paused anything. Three things combined:
//
//   1. The state carried no version, so a poll payload was indistinguishable
//      from a FRESH poll payload and a STALE one. The client applied whichever
//      arrived last.
//   2. Pause state is cached 30s per process. The write landed on one Cloud Run
//      instance; the next poll was answered by another instance still holding
//      the pre-resume value in its cache. That answer was not wrong when it was
//      cached - it was simply OLD, and nothing could tell.
//   3. The follow-the-poll effect listed `busy` in its dependencies, so it
//      re-ran the instant a write finished and re-applied the LAST prop value it
//      had seen - which predated the write it was waiting for.
//
// Each of those was fixed once before, and the flicker came back, because the
// missing thing was not a guard around a poll: it was the notion that a piece of
// server state has an ORDER. With a version, a stale answer is recognisable as
// stale by construction, from any instance, with no coordination between them -
// the version comes from the durable record itself, so an instance with an old
// cache necessarily reports an old version.
//
// Pure and runtime-agnostic on purpose: the same rule guards the client hook and
// can be asserted directly in tests.

/** A value plus the monotonic version of the record it came from. */
export interface Versioned<T> {
  value: T;
  /** Higher is newer. Epoch milliseconds of the durable record works well. */
  version: number;
}

/** No version known yet. Any real version beats it. */
export const UNKNOWN_VERSION = 0;

/**
 * THE rule: the client adopts `incoming` only when it is strictly newer than
 * what it has already applied. Everything else - a stale cache on another
 * instance, a slow poll that overtook a write, a re-fired effect replaying an
 * old prop - is a version that is not newer, and is dropped.
 *
 * An equal version is NOT adopted: it carries no new information, and adopting
 * it would overwrite a local optimistic value that is about to be confirmed.
 */
export function applyIfNewer<T>(
  current: Versioned<T> | null,
  incoming: Versioned<T> | null | undefined
): Versioned<T> | null {
  if (!incoming || !Number.isFinite(incoming.version)) return current;
  if (!current) return incoming;
  return incoming.version > current.version ? incoming : current;
}

/**
 * The version to stamp on an OPTIMISTIC local flip, given the version it is
 * built on. It must outrank every answer that predates the write - including
 * answers from instances whose cache is up to `cacheTtlMs` old - and it must be
 * outranked by the server's own confirmation, which is stamped from the durable
 * record at write time (i.e. at least `nowMs`).
 *
 * Sitting it just BELOW `nowMs` gives exactly that ordering, so an optimistic
 * flip cannot be yanked back by a stale poll, and cannot outlive being
 * corrected by the server if the write actually failed.
 */
export function optimisticVersion(current: Versioned<unknown> | null, nowMs: number): number {
  return Math.max(current?.version ?? UNKNOWN_VERSION, nowMs - 1);
}

/**
 * Is a cached value too old to answer a caller who has already SEEN version
 * `knownVersion`? Used server-side so a per-process cache cannot serve an
 * answer the client already knows to be superseded - the cross-instance half of
 * the same rule.
 */
export function cacheIsStale(
  cachedVersion: number | undefined,
  knownVersion: number | undefined
): boolean {
  if (!knownVersion || !Number.isFinite(knownVersion)) return false;
  return !cachedVersion || cachedVersion < knownVersion;
}
