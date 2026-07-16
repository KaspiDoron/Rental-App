// Session-level flags stamped as marker rows in whatsapp_messages (the exact
// same pattern as the existing `session-closed` marker) - durable, ordered,
// and readable from every serverless instance. Currently: pause/resume.
//
// Paused means: replies are still stored, pushes still arrive, but the agents
// send NOTHING until the user resumes. The user asked Will to hold - holding
// must be absolute.

import { sbInsert, sbSelect } from "./runtime-config";

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
  cache().set(email, { paused, at: Date.now() });
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
  takeoverCache().set(key, { paused: on, at: Date.now() });
  return ok;
}

/** Did the user take this shop's thread over? Latest marker wins. 30s cache. */
export async function isThreadTakenOver(email: string, digits: string): Promise<boolean> {
  const key = `${email}:${digits}`;
  const hit = takeoverCache().get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.paused;
  try {
    const rows = await sbSelect<{ raw: { kind?: string } | null }>(
      "whatsapp_messages",
      `select=raw&to_number=eq.takeover&raw->>sender=eq.${encodeURIComponent(
        email
      )}&raw->>digits=eq.${encodeURIComponent(
        digits
      )}&raw->>kind=in.(human-takeover,human-handback)&order=received_at.desc&limit=1`
    );
    const on = rows[0]?.raw?.kind === "human-takeover";
    takeoverCache().set(key, { paused: on, at: Date.now() });
    return on;
  } catch {
    return hit?.paused ?? false;
  }
}

/** Is this user's session paused? Latest pause/resume marker wins. 30s cache. */
export async function isSessionPaused(email: string): Promise<boolean> {
  const hit = cache().get(email);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.paused;
  try {
    const rows = await sbSelect<{ raw: { kind?: string } | null; received_at: string }>(
      "whatsapp_messages",
      `select=raw,received_at&to_number=eq.session&raw->>sender=eq.${encodeURIComponent(
        email
      )}&raw->>kind=in.(session-paused,session-resumed)&order=received_at.desc&limit=1`
    );
    const paused = rows[0]?.raw?.kind === "session-paused";
    cache().set(email, { paused, at: Date.now() });
    return paused;
  } catch {
    return hit?.paused ?? false;
  }
}
