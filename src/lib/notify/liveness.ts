// IS THE HUNT STILL ON? - the fact every push was missing.
//
// The owner's phone buzzed HOURS after their search session had ended, every
// time a rental shop got around to replying on WhatsApp. Every emit site
// judged the EVENT (is this price news? is this reply significant?) and none
// of them judged the HUNT - and a hunt can end two ways that leave different
// evidence:
//
//   1. The traveller cleared it. /api/session/close writes a durable
//      `session-closed` marker; the agent gates already honor it, the push
//      paths never looked.
//   2. It simply EXPIRED. The 3h TTL (session-life.ts) is enforced by the
//      client dropping `wd_search` from sessionStorage - the server keeps no
//      tombstone at all, so nothing server-side ever learns the hunt is over.
//
// One predicate, consumed by `notifyState` so `worthAnInterruption` can
// suppress hunt-scoped pushes in a single place instead of at six emit sites.
//
// FAIL DIRECTION: `null` (unreadable) leans toward PUSHING. A missed
// suppression is one unwanted buzz; a suppression on a store blip is a real
// price the traveller never hears about. The breadcrumb the caller writes
// makes the unknown case auditable rather than silent.

import "server-only";
import { isRealHunt, isSessionFresh } from "../session-life";

export interface HuntState {
  /** true = a live hunt; false = over (cleared or expired); null = unreadable. */
  live: boolean | null;
  /** The newest real hunt's start - the honest floor for per-hunt facts. */
  startedIso?: string;
  /** Why `live` is false, when it is. */
  reason?: "no-hunt" | "cleared" | "ttl-expired";
}

/**
 * The newest real hunt's liveness, plus its start time so callers can floor
 * their own queries to THIS hunt instead of all time.
 */
export async function huntState(email: string, nowMs = Date.now()): Promise<HuntState> {
  if (!email) return { live: false, reason: "no-hunt" };
  const { sbSelectStrict, sbSelect } = await import("../runtime-config");
  const who = encodeURIComponent(email);

  // Enough rows to skip the request-build analytics rows (source panel /
  // profiler) that share the table - the same discriminator every hunt
  // surface uses.
  const huntsRead = await sbSelectStrict<{ source: string | null; created_at: string }>(
    "searches",
    `select=source,created_at&user_email=eq.${who}&order=created_at.desc&limit=12`
  );
  if ("error" in huntsRead) {
    // Unreadable OR the table does not exist (demo mode): unknown, lean open.
    return { live: null };
  }
  const newest = huntsRead.rows.find((r) => isRealHunt(r.source));
  if (!newest) return { live: false, reason: "no-hunt" };
  const started = Date.parse(newest.created_at);
  if (!Number.isFinite(started)) return { live: false, reason: "no-hunt" };

  // Cleared AFTER it started -> over, whatever the TTL says. Permissive read:
  // an unreadable marker leans toward "not cleared" (the open direction), and
  // the TTL below still bounds how long that lean can matter.
  const marker = await sbSelect<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&to_number=eq.session&raw->>sender=eq.${who}&raw->>kind=eq.session-closed&order=received_at.desc&limit=1`
  ).catch(() => [] as { received_at: string }[]);
  const clearedAt = Date.parse(marker[0]?.received_at ?? "");
  if (Number.isFinite(clearedAt) && clearedAt > started) {
    return { live: false, startedIso: newest.created_at, reason: "cleared" };
  }

  const { searchSessionTtlMs } = await import("../session-life-config");
  const ttl = await searchSessionTtlMs();
  return isSessionFresh(started, nowMs, ttl)
    ? { live: true, startedIso: newest.created_at }
    : { live: false, startedIso: newest.created_at, reason: "ttl-expired" };
}

/** The boolean most callers want. See huntState for the semantics. */
export async function huntIsLive(email: string, nowMs = Date.now()): Promise<boolean | null> {
  return (await huntState(email, nowMs)).live;
}
