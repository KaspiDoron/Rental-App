// FLEET TRUTH - plan Part 9.7, ranked the largest information gain per line in
// the system, and it is cheaper than it looks.
//
// `/instance/fetchInstances` is ALREADY CALLED three times in `evolution.ts`,
// and every one of those calls throws away almost everything the response
// contains. Only `connectionStatus` is read. Discarded: the numeric disconnect
// reason, the disconnect time, the message/contact/chat counts, the settings
// actually in force, the proxy actually applied, the owner JID and the creation
// time. One response per host answers six separate dashboard questions:
//
//   1. real connection state, per instance rather than per our own cache;
//   2. the numeric disconnect reason - the one Part 0.37 found we regex-matched
//      as a WORD while Evolution sends a NUMBER, so the branch never fired;
//   3. DEAF SESSIONS - `_count.Message` flat while outbound is live is the
//      app-layer substitute for the Baileys probe we cannot run, because we do
//      not hold the socket;
//   4. which settings are genuinely in force, versus what we believe we set;
//   5. proxy-applied verification, which today is asserted and never checked;
//   6. DUAL SOCKETS - the same instance reporting `open` on more than one host,
//      which is the condition that produces `connectionReplaced` and which we
//      have been unable to see at all.
//
// So this module is field extraction, not new plumbing.
//
// A FAILED HOST RETURNS null, NEVER []. That distinction is the whole fail-dark
// contract in one line: an empty array reads as "the fleet is fine and empty",
// which is exactly the lie the Command Center shipped nine times over.

import { getHosts, type Host } from "../evolution";

/**
 * Evolution v2 speaks at least two dialects for the same record -
 * `{name, connectionStatus}` and `{instance: {instanceName, state|status}}` -
 * and a third shape shows up on some builds. This resolves a field across all
 * of them.
 *
 * Extracted and exported rather than re-written, because `stateFromFetchInstances`
 * already carries this matcher and a SECOND dialect table is how the two drift
 * into disagreeing about the same host.
 */
export function pickInstanceField(record: unknown, ...names: string[]): unknown {
  if (!record || typeof record !== "object") return undefined;
  const r = record as Record<string, unknown>;
  const inner =
    r.instance && typeof r.instance === "object" ? (r.instance as Record<string, unknown>) : null;
  for (const n of names) {
    if (r[n] !== undefined && r[n] !== null) return r[n];
    if (inner && inner[n] !== undefined && inner[n] !== null) return inner[n];
  }
  return undefined;
}

export interface InstanceTruth {
  /** Evolution's instance name. Ours are derived from the user's email. */
  name: string;
  /** Normalised: "open" | "connecting" | "close" | whatever it actually said. */
  state: string | null;
  /** THE NUMBER, not a word. 401/403/411/440 and friends. */
  disconnectCode: number | null;
  disconnectAt: string | null;
  messages: number | null;
  contacts: number | null;
  chats: number | null;
  /** Whether a proxy is actually attached to this instance right now. */
  proxied: boolean | null;
  ownerJid: string | null;
  createdAt: string | null;
  /** Which host reported it. Two hosts reporting one name is the dual socket. */
  host: string;
}

export interface FleetTruth {
  instances: InstanceTruth[];
  /** Hosts that answered. */
  hostsOk: string[];
  /**
   * Hosts that did NOT answer, with the reason.
   *
   * Rendered as a dark strip rather than folded into the counts, because a
   * fleet of 200 that reads "12 open" while three hosts are unreachable is a
   * more dangerous number than no number at all.
   */
  hostsDark: { host: string; reason: string }[];
  /**
   * Instance names reporting `open` on more than one host.
   *
   * The dual-socket condition. WhatsApp answers it with `connectionReplaced`,
   * and until now nothing in this system could observe it - `render.yaml` even
   * advises adding hosts, which would multiply it.
   */
  dualSockets: string[];
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Turn one raw record into an `InstanceTruth`. Pure, so the dialect handling is
 * testable without a live Evolution host - which is the only way it will ever
 * actually be tested.
 */
export function parseInstanceRecord(record: unknown, host: string): InstanceTruth | null {
  const name = strOrNull(pickInstanceField(record, "name", "instanceName", "instance_name"));
  if (!name) return null;
  const rawState = strOrNull(
    pickInstanceField(record, "connectionStatus", "state", "status", "connection_status")
  );
  // Evolution says "connected"; every consumer in this repo says "open". One
  // spelling, resolved here, so a tile and a badge cannot disagree.
  const state = rawState ? (rawState.toLowerCase() === "connected" ? "open" : rawState.toLowerCase()) : null;

  const counts = pickInstanceField(record, "_count") as Record<string, unknown> | undefined;
  const proxy = pickInstanceField(record, "Proxy", "proxy");

  return {
    name,
    state,
    disconnectCode: numOrNull(
      pickInstanceField(record, "disconnectionReasonCode", "disconnection_reason_code")
    ),
    disconnectAt: strOrNull(pickInstanceField(record, "disconnectionAt", "disconnection_at")),
    messages: counts ? numOrNull(counts.Message ?? counts.message) : null,
    contacts: counts ? numOrNull(counts.Contact ?? counts.contact) : null,
    chats: counts ? numOrNull(counts.Chat ?? counts.chat) : null,
    // `null` means the host did not report the field at all - which is NOT the
    // same as "no proxy is attached", and a dashboard that renders the two the
    // same way would report unverified egress as verified-absent.
    proxied: proxy === undefined ? null : Boolean(proxy),
    ownerJid: strOrNull(pickInstanceField(record, "ownerJid", "owner_jid")),
    createdAt: strOrNull(pickInstanceField(record, "createdAt", "created_at")),
    host,
  };
}

/** Which instance names are reporting `open` from more than one host. */
export function findDualSockets(instances: InstanceTruth[]): string[] {
  const openHostsByName = new Map<string, Set<string>>();
  for (const i of instances) {
    if (i.state !== "open") continue;
    const set = openHostsByName.get(i.name) ?? new Set<string>();
    set.add(i.host);
    openHostsByName.set(i.name, set);
  }
  return [...openHostsByName.entries()]
    .filter(([, hosts]) => hosts.size > 1)
    .map(([name]) => name)
    .sort();
}

/**
 * A DEAF SESSION, at the app layer.
 *
 * C4's literal remedy - a 30s probe plus `sock.end()` - assumes we hold the
 * Baileys socket. We do not; it lives in the Evolution container. What we can
 * see is the shape: the instance says `open`, its keepalives are evidently fine
 * because Evolution still lists it, and yet its message count has not moved
 * while we were actively sending. That is the observable half of the same
 * condition, and it is the only half available to us.
 *
 * Requires a PRIOR reading to compare against, so it is a pure function of two
 * samples rather than a property of one.
 */
export function looksDeaf(
  prev: Pick<InstanceTruth, "state" | "messages">,
  next: Pick<InstanceTruth, "state" | "messages">,
  outboundSince: number
): boolean {
  if (next.state !== "open" || prev.state !== "open") return false;
  // Unknown counts are unknown. Treating a missing count as "flat" would report
  // every instance on a build that does not send `_count` as deaf.
  if (prev.messages === null || next.messages === null) return false;
  if (outboundSince <= 0) return false;
  return next.messages <= prev.messages;
}

const HOST_TIMEOUT_MS = 5_000;

/**
 * One HTTP call per host, no instanceName filter, full record extraction.
 *
 * Cost: one request per host per invocation, called from the hourly rollup
 * rather than a live fan-out. `/api/activity` is the counter-example already in
 * this repo - ~21 Supabase round trips per tick plus two awaited 8-second
 * WhatsApp drains before it reads anything - and at fleet scale a live monitor
 * becomes the load it monitors.
 */
export async function fleetTruth(): Promise<FleetTruth | null> {
  let hosts: Host[] = [];
  try {
    hosts = await getHosts();
  } catch {
    return null;
  }
  // No hosts configured is not a healthy empty fleet, it is an unreadable one.
  if (hosts.length === 0) return null;

  const instances: InstanceTruth[] = [];
  const hostsOk: string[] = [];
  const hostsDark: { host: string; reason: string }[] = [];

  await Promise.all(
    hosts.map(async (h) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HOST_TIMEOUT_MS);
      try {
        const res = await fetch(`${h.url}/instance/fetchInstances`, {
          headers: { apikey: h.key },
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          hostsDark.push({ host: h.url, reason: `HTTP ${res.status}` });
          return;
        }
        const data: unknown = await res.json();
        const arr: unknown[] = Array.isArray(data) ? data : data ? [data] : [];
        for (const rec of arr) {
          const parsed = parseInstanceRecord(rec, h.url);
          if (parsed) instances.push(parsed);
        }
        hostsOk.push(h.url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unreachable";
        hostsDark.push({ host: h.url, reason: /abort/i.test(msg) ? "no response in 5s" : msg });
      } finally {
        clearTimeout(timer);
      }
    })
  );

  // Every host dark is indistinguishable from a dead fleet, so say nothing
  // rather than report an empty one.
  if (hostsOk.length === 0) return null;

  return { instances, hostsOk, hostsDark, dualSockets: findDualSockets(instances) };
}
