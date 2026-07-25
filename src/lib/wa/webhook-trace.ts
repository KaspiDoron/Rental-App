// Best-effort webhook observability. The webhook verifier used to accept/reject
// events with ZERO trace, so a stale-token 403 storm (the live incident) was
// invisible in the app - only Evolution's own container logs showed it. These
// helpers leave a throttled breadcrumb so the Engine panel + Command tab + WA
// doctor can prove inbound liveness (or the lack of it).
//
// Safety on the UNAUTHENTICATED 403 path: never parse the body pre-auth, never
// read the DB, never log the full token, and throttle hard (per process) so a
// flood can never turn instrumentation into a self-inflicted DB DoS.

import "server-only";
import { sbInsert } from "../runtime-config";
import { makeTraceThrottle } from "./trace-throttle";

const okThrottle = makeTraceThrottle(60_000); // 1/min per instance
const denyThrottle = makeTraceThrottle(5 * 60_000); // 1/5min per process key
const dropThrottle = makeTraceThrottle(5 * 60_000); // 1/5min per (email|digits|reason)

/** Record that a webhook event was ACCEPTED (the durable "last inbound accepted
 * at"). Keyed per instance, at most once/min. */
export async function noteWebhookAccepted(instance?: string, event?: string): Promise<void> {
  if (!okThrottle.allow(`ok:${instance ?? "?"}`)) return;
  await sbInsert("agent_events", [
    {
      kind: "webhook-ok",
      vendor_id: "",
      vendor_name: instance ?? "",
      detail: JSON.stringify({ instance: instance ?? null, event: event ?? null }),
    },
  ]).catch(() => {});
}

/** Record a REJECTED webhook (403). Per-process throttle; only a 4-char token
 * prefix is ever recorded. Call AFTER deciding to 403 and WITHOUT touching the
 * request body. */
export async function noteWebhook403(path: string, presented: string | null | undefined): Promise<void> {
  if (!denyThrottle.allow(`403:${path}`)) return;
  const prefix = typeof presented === "string" && presented.length >= 4 ? presented.slice(0, 4) : "none";
  await sbInsert("agent_events", [
    {
      kind: "webhook-403",
      vendor_id: "",
      vendor_name: path,
      detail: JSON.stringify({ path, tokenPrefix: prefix }),
    },
  ]).catch(() => {});
}

/** Record a shop reply that was DROPPED by a gate that used to be silent (the
 * vendor-gate, a missing RFQ thread, a takeover/pause hold, a sync error).
 * Throttled per (email|digits|reason) so a chatty thread cannot flood the feed.
 * Stamped with user_email for ownership-scoped reads. */
export async function noteInboundDropped(
  email: string | null | undefined,
  digits: string | null | undefined,
  reason: string,
  extra?: Record<string, unknown>
): Promise<void> {
  if (!dropThrottle.allow(`drop:${email ?? "?"}|${digits ?? "?"}|${reason}`)) return;
  await sbInsert("agent_events", [
    {
      kind: "inbound-dropped",
      vendor_id: "",
      vendor_name: digits ?? "",
      ...(email ? { user_email: email } : {}),
      detail: JSON.stringify({ reason, digits: digits ?? null, ...(extra ?? {}) }),
    },
  ]).catch(() => {});
}
