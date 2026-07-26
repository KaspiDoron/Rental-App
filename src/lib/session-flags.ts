// Session-level flags stamped as marker rows in whatsapp_messages (the exact
// same pattern as the existing `session-closed` marker) - durable, ordered,
// and readable from every serverless instance. Currently: pause/resume.
//
// Paused means: replies are still stored, pushes still arrive, but the agents
// send NOTHING until the user resumes. The user asked Will to hold - holding
// must be absolute.

import { sbInsert, sbSelectStrict } from "./runtime-config";
import { boundedSet } from "./bounded-map";

// These caches live for the whole PROCESS lifetime in the workers (which import
// all of src/lib), so an unbounded Map grows one entry per user - and the
// takeover one per user x shop. Both are 30s-TTL freshness caches over
// authoritative Supabase rows, so evicting a cold entry just costs one re-read.
const CACHE_CAP = 5000;

interface CacheEntry {
  paused: boolean;
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_session_flags__: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  if (!globalThis.__wd_session_flags__) globalThis.__wd_session_flags__ = new Map();
  return globalThis.__wd_session_flags__;
}

const TTL_MS = 30_000;

/** Stamp a pause or resume marker for this user's whole search session. */
export async function setSessionPaused(email: string, paused: boolean): Promise<boolean> {
  const kind = paused ? "session-paused" : "session-resumed";
  const ok = await sbInsert("whatsapp_messages", [
    {
      from_number: "system",
      to_number: "session",
      body: `[${kind}]`,
      direction: "outbound",
      raw: { sender: email, kind },
    },
  ]);
  boundedSet(cache(), email, { paused, at: Date.now() }, CACHE_CAP);
  return ok;
}

// ---------------------------------------------------------------------------
// Human takeover - per shop thread. When the user types in a shop's WhatsApp
// thread themselves, the agents stand down for THAT thread until handback.
// Marker rows: to_number "takeover", raw {sender, digits, kind}.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wd_takeover_flags__: Map<string, CacheEntry> | undefined;
}

function takeoverCache(): Map<string, CacheEntry> {
  if (!globalThis.__wd_takeover_flags__) globalThis.__wd_takeover_flags__ = new Map();
  return globalThis.__wd_takeover_flags__;
}

export async function setThreadTakeover(
  email: string,
  digits: string,
  on: boolean
): Promise<boolean> {
  const kind = on ? "human-takeover" : "human-handback";
  const key = `${email}:${digits}`;
  const ok = await sbInsert("whatsapp_messages", [
    {
      from_number: "system",
      to_number: "takeover",
      body: `[${kind} ${digits}]`,
      direction: "outbound",
      raw: { sender: email, digits, kind },
    },
  ]);
  boundedSet(takeoverCache(), key, { paused: on, at: Date.now() }, CACHE_CAP);
  return ok;
}

/**
 * Did the user take this shop's thread over? Latest marker wins, 30s cache.
 * TRI-STATE, because takeover is an ABSOLUTE veto (like the cancellation
 * tombstone): true (taken over), false (definitely not), or null (the store is
 * UNREADABLE right now - the truth is unknown). The old permissive sbSelect
 * collapsed a transient DB failure to [] -> false and CACHED that false for
 * 30s, so a blip let the agent talk over a human for up to half a minute. A
 * null must make automated sends fail CLOSED, and is never cached.
 */
export async function isThreadTakenOver(
  email: string,
  digits: string
): Promise<boolean | null> {
  const key = `${email}:${digits}`;
  const hit = takeoverCache().get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.paused;
  const res = await sbSelectStrict<{ raw: { kind?: string } | null }>(
    "whatsapp_messages",
    `select=raw&to_number=eq.takeover&raw->>sender=eq.${encodeURIComponent(
      email
    )}&raw->>digits=eq.${encodeURIComponent(
      digits
    )}&raw->>kind=in.(human-takeover,human-handback)&order=received_at.desc&limit=1`
  );
  if ("error" in res) {
    // "missing" (no such table/column, demo mode) -> genuinely no marker.
    // "unavailable" (transient) -> UNKNOWN. Never cache, and only honor a stale
    // cache entry in the FAIL-CLOSED direction: a stale `true` keeps holding,
    // but a stale `false` must NOT be returned (the real state may have flipped
    // to taken-over on another instance during the blip) - fall through to null
    // so the guard fails closed.
    return res.error === "missing" ? false : hit?.paused === true ? true : null;
  }
  const on = res.rows[0]?.raw?.kind === "human-takeover";
  boundedSet(takeoverCache(), key, { paused: on, at: Date.now() }, CACHE_CAP);
  return on;
}

/**
 * Is this user's session paused? Latest pause/resume marker wins, 30s cache.
 * TRI-STATE for the same reason as isThreadTakenOver: null = store unreadable,
 * never cached, automated sends fail closed.
 */
export async function isSessionPaused(email: string): Promise<boolean | null> {
  const hit = cache().get(email);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.paused;
  const res = await sbSelectStrict<{ raw: { kind?: string } | null; received_at: string }>(
    "whatsapp_messages",
    `select=raw,received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
      email
    )}&raw->>kind=in.(session-paused,session-resumed)&order=received_at.desc&limit=1`
  );
  if ("error" in res) {
    // Same fail-closed-direction rule as isThreadTakenOver: a stale `true`
    // (still paused) is honored, a stale `false` is never returned - null so
    // automated sends hold rather than slip through during a store blip.
    return res.error === "missing" ? false : hit?.paused === true ? true : null;
  }
  const paused = res.rows[0]?.raw?.kind === "session-paused";
  boundedSet(cache(), email, { paused, at: Date.now() }, CACHE_CAP);
  return paused;
}

// ---------------------------------------------------------------------------
// Session status - the single enum the ask requested (ACTIVE / PAUSED /
// TERMINATED / DEAL_CLOSED), DERIVED from the markers we already stamp rather
// than a new column. Newest marker wins across the two families:
//   - to_number "session", kind session-closed  -> terminated / deal-closed
//     (deal-closed carries raw.reason "deal-closed"; a bare close is user-closed)
//   - to_number "session", kind session-paused/session-resumed -> paused / active
// A close ALWAYS outranks a pause at the same instant (a terminated session is
// not merely paused). No marker at all -> active.
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "paused" | "terminated" | "deal-closed";

export async function getSessionStatus(email: string): Promise<SessionStatus> {
  const res = await sbSelectStrict<{ raw: { kind?: string; reason?: string } | null }>(
    "whatsapp_messages",
    `select=raw&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
      email
    )}&raw->>kind=in.(session-closed,session-paused,session-resumed)&order=received_at.desc&limit=1`
  );
  // Unreadable / demo mode -> report active (the hard inbound gates fail closed
  // on their own tri-state reads; this enum is for UI + drain hints, not the
  // safety veto, so it must not wedge the UI into a false "stopped").
  if ("error" in res) return "active";
  const row = res.rows[0]?.raw;
  if (!row) return "active";
  if (row.kind === "session-closed") {
    return row.reason === "deal-closed" ? "deal-closed" : "terminated";
  }
  return row.kind === "session-paused" ? "paused" : "active";
}
