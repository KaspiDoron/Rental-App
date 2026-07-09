// Evolution API integration - per-user WhatsApp sessions via QR scan.
//
// Why: without a registered business you cannot pass Meta's verification for
// the official Cloud API. Evolution API (open source, self-hosted, free) lets
// each traveller connect their OWN personal WhatsApp by scanning a QR code in
// their Profile - messages then go out from their real number (authentic
// bargaining) and replies stream back into the app through our webhook.
//
// HONESTY & SAFETY: this rides the unofficial WhatsApp Web protocol, which is
// against WhatsApp's Terms of Service - numbers CAN get banned if they behave
// like bots. We therefore enforce strict, human-like limits below (min gap
// between messages, hourly/daily caps, typing delay) and the UI warns users.
//
// Config (Admin -> Keys): EVOLUTION_API_URL, EVOLUTION_API_KEY.

import "server-only";
import { createHash } from "crypto";
import { getConfig, sbInsert, sbSelect, sbDelete } from "./runtime-config";

// ---- anti-ban limits (human-like behaviour; owner-adjustable in Admin) --------
const MIN_GAP_MS = 20_000; // never two messages within 20s per user
const TYPING_DELAY_MS = () => 1200 + Math.floor(Math.random() * 2300);

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_wa_rate__: Map<string, number[]> | undefined;
}

function rateStore() {
  if (!globalThis.__wheeldeal_wa_rate__) globalThis.__wheeldeal_wa_rate__ = new Map();
  return globalThis.__wheeldeal_wa_rate__;
}

export interface RateVerdict {
  allowed: boolean;
  reason?: string;
  waitSeconds?: number;
}

/** Human-like send budget per user. Durable check + in-memory fast path. */
export async function checkRateLimit(email: string): Promise<RateVerdict> {
  const now = Date.now();
  const mem = rateStore().get(email) ?? [];
  const recent = mem.filter((t) => now - t < 24 * 3600_000);

  if (recent.length && now - recent[recent.length - 1] < MIN_GAP_MS) {
    return {
      allowed: false,
      reason: "Sending too fast - a human never fires messages back-to-back.",
      waitSeconds: Math.ceil((MIN_GAP_MS - (now - recent[recent.length - 1])) / 1000),
    };
  }

  // Durable hourly/daily counts (webhook + other instances included).
  const hourIso = new Date(now - 3600_000).toISOString();
  const rows = await sbSelect<{ id: number; received_at: string }>(
    "whatsapp_messages",
    `select=id,received_at&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}&limit=200`
  );
  const lastHour = rows.filter((r) => r.received_at >= hourIso).length;
  const lastDay = rows.length;

  const { limitFor } = await import("./usage");
  const maxHour = await limitFor("LIMIT_WA_PER_HOUR");
  const maxDay = await limitFor("LIMIT_WA_PER_DAY");

  if (lastHour + recent.filter((t) => now - t < 3600_000).length >= maxHour) {
    return {
      allowed: false,
      reason: `Hourly safety cap reached (${maxHour}/h). This protects your WhatsApp number from being flagged.`,
      waitSeconds: 900,
    };
  }
  if (lastDay + recent.length >= maxDay) {
    return {
      allowed: false,
      reason: `Daily safety cap reached (${maxDay}/day). Try again tomorrow - this protects your number.`,
    };
  }
  return { allowed: true };
}

export function recordSend(email: string) {
  const now = Date.now();
  const mem = (rateStore().get(email) ?? []).filter((t) => now - t < 24 * 3600_000);
  mem.push(now);
  rateStore().set(email, mem);
}

// ---- Multi-host Evolution client -----------------------------------------------
//
// Free hosts (Render/Koyeb/etc.) sleep and restart. To stay reliable on 100%
// free tiers we support a POOL of Evolution servers that all point at the SAME
// Supabase Postgres database. Because the Baileys credentials live in that
// shared DB, ANY host can resume a user's session - so if a user's host is
// asleep/down we transparently fail the user over to a healthy host with NO
// re-linking. Users are also sharded across hosts to spread the load and stay
// within each free tier's limits.
//
// Config (Admin -> Keys):
//   EVOLUTION_HOSTS  (preferred) - one "url|apikey" per line/comma, e.g.
//       https://wd-wa-1.onrender.com|KEY1
//       https://wd-wa-2.koyeb.app|KEY2
//   EVOLUTION_API_URL + EVOLUTION_API_KEY - single-host fallback (legacy).

export interface Host {
  url: string;
  key: string;
}

async function getHosts(): Promise<Host[]> {
  const multi = (await getConfig("EVOLUTION_HOSTS")) ?? "";
  const parsed = multi
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [url, key] = line.split("|").map((x) => x?.trim());
      return url && key ? { url: url.replace(/\/$/, ""), key } : null;
    })
    .filter((h): h is Host => h !== null);
  if (parsed.length) return parsed;

  const [url, key] = await Promise.all([
    getConfig("EVOLUTION_API_URL"),
    getConfig("EVOLUTION_API_KEY"),
  ]);
  if (url && key) return [{ url: url.trim().replace(/\/$/, ""), key: key.trim() }];
  return [];
}

export async function evolutionConfigured(): Promise<boolean> {
  return (await getHosts()).length > 0;
}

interface Proxy {
  host: string;
  port: string;
  protocol: string;
  username: string;
  password: string;
}

/**
 * Optional residential proxy for the WhatsApp WebSocket. Datacenter IPs (Render
 * / cloud) are a TOP-weighted ban signal per the research (Φ_net); routing
 * through a residential SOCKS5/HTTP proxy that maps to the phone's country is
 * the single biggest network-level protection. Config EVOLUTION_PROXY accepts a
 * URL: socks5://user:pass@host:port  (or http://host:port).
 */
function proxyFromUrl(raw: string): Proxy | null {
  try {
    const u = new URL(raw.trim());
    return {
      protocol: u.protocol.replace(":", "") || "socks5",
      host: u.hostname,
      port: u.port || (u.protocol.startsWith("socks") ? "1080" : "8080"),
      username: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the proxy for a given user, in priority order:
 *   1. EVOLUTION_PROXY_POOL - one proxy URL per line; each user is pinned to a
 *      stable line by hashing their email (unique residential IP per instance,
 *      the post-revenue scaling step). A user always maps to the same proxy.
 *   2. EVOLUTION_PROXY - a single shared proxy (pre-revenue / testing).
 * Returns null when neither is set (datacenter IP - baseline behaviour).
 */
async function parseProxy(email?: string): Promise<Proxy | null> {
  const pool = (await getConfig("EVOLUTION_PROXY_POOL"))?.trim();
  if (pool && email) {
    const lines = pool.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) {
      const h = createHash("sha256").update(email.toLowerCase()).digest();
      const idx = h.readUInt32BE(0) % lines.length;
      const p = proxyFromUrl(lines[idx]);
      if (p) return p;
    }
  }
  const raw = (await getConfig("EVOLUTION_PROXY"))?.trim();
  return raw ? proxyFromUrl(raw) : null;
}

/** Deterministic, collision-safe instance name for a user (same on every host). */
export function instanceNameFor(email: string): string {
  return `wd-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** Webhook token derived from a stable secret so it works across all hosts. */
export async function webhookToken(): Promise<string | null> {
  if ((await getHosts()).length === 0) return null;
  const secret = process.env.SESSION_SECRET || "wd-fallback-secret";
  return createHash("sha256").update(`wd-webhook:${secret}`).digest("hex").slice(0, 32);
}

// ---- host health (short-lived cache) --------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_health__: Map<string, { ok: boolean; detail: string; exp: number }> | undefined;
}
function healthStore() {
  if (!globalThis.__wd_wa_health__) globalThis.__wd_wa_health__ = new Map();
  return globalThis.__wd_wa_health__;
}

/**
 * Probe one host and explain the result. "ok" means reachable and not
 * server-erroring (a 401 still means the box is ALIVE - just a wrong key), so
 * the pool keeps using it. The human-readable detail powers the owner panel's
 * "why is this host down" line and the per-host Test API output.
 */
async function hostHealthDetail(h: Host): Promise<{ ok: boolean; detail: string }> {
  const cache = healthStore();
  const hit = cache.get(h.url);
  if (hit && hit.exp > Date.now()) return { ok: hit.ok, detail: hit.detail };

  let ok = false;
  let detail = "";
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(`${h.url}/instance/fetchInstances`, {
      headers: { apikey: h.key },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    const ms = Date.now() - started;
    if (res.status < 500) {
      ok = true; // reachable and not erroring (401 still = alive)
      detail =
        res.status === 401 || res.status === 403
          ? `Awake but rejecting the API key (HTTP ${res.status}) - check this host's AUTHENTICATION_API_KEY matches the key in EVOLUTION_HOSTS.`
          : `Healthy (HTTP ${res.status}, ${ms}ms).`;
    } else {
      detail = `Server error HTTP ${res.status} - the container is up but Evolution is crashing (usually a bad DATABASE_CONNECTION_URI).`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unreachable";
    detail = /abort/i.test(msg)
      ? "No response within 4.5s - host is asleep or cold-starting. Keep-awake cron should wake it; the pool routes around it meanwhile."
      : `Unreachable: ${msg}. Check the URL is correct and the service is deployed.`;
  }
  cache.set(h.url, { ok, detail, exp: Date.now() + 15_000 });
  return { ok, detail };
}

async function hostHealthy(h: Host): Promise<boolean> {
  return (await hostHealthDetail(h)).ok;
}

function hostPref(email: string, url: string): number {
  return parseInt(
    createHash("sha256").update(`${email.toLowerCase()}:${url}`).digest("hex").slice(0, 8),
    16
  );
}

/**
 * How many paired users each host currently carries (for even load-balancing).
 * Cached 10s so a burst of concurrent sends from hundreds of users does not fire
 * one table scan per message - the count only needs to be approximately fresh.
 */
declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_counts__: { data: Record<string, number>; exp: number } | undefined;
}
async function hostUserCounts(): Promise<Record<string, number>> {
  const cache = globalThis.__wd_wa_counts__;
  if (cache && cache.exp > Date.now()) return cache.data;
  const rows = await sbSelect<{ host_url: string | null }>(
    "wa_sessions",
    "select=host_url&status=eq.open&limit=50000"
  );
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.host_url) counts[r.host_url] = (counts[r.host_url] ?? 0) + 1;
  globalThis.__wd_wa_counts__ = { data: counts, exp: Date.now() + 10_000 };
  return counts;
}

/** Nudge the cached count when we place/relocate a user, so back-to-back new
 *  users in the same 10s window don't all pile onto the same "emptiest" host. */
function bumpHostCount(url: string, by = 1) {
  const cache = globalThis.__wd_wa_counts__;
  if (cache && cache.exp > Date.now()) {
    cache.data[url] = (cache.data[url] ?? 0) + by;
  }
}

/** Soft cap of paired users per host (owner-adjustable). */
async function maxPerHost(): Promise<number> {
  const v = Number(await getConfig("EVOLUTION_MAX_PER_HOST"));
  return Number.isFinite(v) && v > 0 ? v : 40;
}

/**
 * The Evolution host this user's session should live on right now.
 *
 * Scales cleanly to many hosts: health is probed in PARALLEL, a paired user
 * sticks to their (healthy) host, and brand-new users are placed on the
 * LEAST-LOADED healthy host under the per-host cap - so load spreads evenly and
 * no user is left without a home.
 */
async function resolveHost(email: string): Promise<Host | null> {
  const hosts = await getHosts();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return hosts[0];

  // Probe all hosts at once.
  const health = await Promise.all(
    hosts.map(async (h) => ({ h, ok: await hostHealthy(h) }))
  );
  const healthy = health.filter((x) => x.ok).map((x) => x.h);

  // Keep the user on their existing host while it is healthy.
  const rows = await sbSelect<{ host_url: string | null }>(
    "wa_sessions",
    `select=host_url&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  const stored = rows[0]?.host_url;
  if (stored) {
    const h = healthy.find((x) => x.url === stored);
    if (h) return h;
  }

  // Place a new/relocating user on the least-loaded healthy host under the cap.
  const counts = await hostUserCounts();
  const cap = await maxPerHost();
  const pickFrom = healthy.length ? healthy : hosts;
  const underCap = pickFrom.filter((h) => (counts[h.url] ?? 0) < cap);
  const pool = underCap.length ? underCap : pickFrom;
  pool.sort(
    (a, b) =>
      (counts[a.url] ?? 0) - (counts[b.url] ?? 0) ||
      hostPref(email, a.url) - hostPref(email, b.url)
  );
  const chosen = pool[0] ?? null;
  // Reserve a slot immediately so concurrent new users spread out instead of
  // stampeding onto the same emptiest host before the DB count catches up.
  if (chosen && chosen.url !== stored) bumpHostCount(chosen.url);
  return chosen;
}

/** Live health + load + reason of every configured host (for the owner panel). */
export async function hostsStatus(): Promise<
  { url: string; healthy: boolean; users: number; detail: string }[]
> {
  const [hosts, counts] = await Promise.all([getHosts(), hostUserCounts()]);
  return Promise.all(
    hosts.map(async (h) => {
      const { ok, detail } = await hostHealthDetail(h);
      return { url: h.url, healthy: ok, users: counts[h.url] ?? 0, detail };
    })
  );
}

/**
 * On-demand deep test of ONE host: forces a fresh probe (bypassing the 15s
 * cache) and, if the key is accepted, reports how many Evolution instances that
 * server is actually running - so the owner can confirm a specific server is
 * live and its API key/credentials work, right from the Keys screen.
 */
export async function testOneHost(
  url: string
): Promise<{ url: string; healthy: boolean; detail: string; instances?: number }> {
  const hosts = await getHosts();
  const host = hosts.find((h) => h.url === url.replace(/\/$/, ""));
  if (!host) return { url, healthy: false, detail: "This host is not in the pool anymore." };
  healthStore().delete(host.url); // force a live re-check
  const { ok, detail } = await hostHealthDetail(host);
  if (!ok) return { url: host.url, healthy: false, detail };
  // Alive + key accepted: count the live instances as a concrete proof of life.
  try {
    const res = await fetch(`${host.url}/instance/fetchInstances`, {
      headers: { apikey: host.key },
      cache: "no-store",
    });
    const data = await res.json().catch(() => null);
    const instances = Array.isArray(data) ? data.length : undefined;
    return {
      url: host.url,
      healthy: true,
      detail:
        instances === undefined
          ? "Live and the API key works."
          : `Live, API key accepted - running ${instances} WhatsApp instance(s).`,
      instances,
    };
  } catch {
    return { url: host.url, healthy: true, detail: "Live and the API key works." };
  }
}

async function evoFetch(
  host: Host,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(`${host.url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: host.key,
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { error: e instanceof Error ? e.message : "network error" },
    };
  }
}

/** Resolve the user's host and call it. */
async function evo(
  email: string,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  const host = await resolveHost(email);
  if (!host) return { ok: false, status: 0, data: { error: "not configured" } };
  return evoFetch(host, path, init);
}

/** Keep-awake: ping every configured host so none of them sleeps. */
export async function pingAllHosts(): Promise<{ url: string; ok: boolean }[]> {
  const hosts = await getHosts();
  return Promise.all(
    hosts.map(async (h) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`${h.url}/`, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(timer);
        return { url: h.url, ok: res.status < 500 };
      } catch {
        return { url: h.url, ok: false };
      }
    })
  );
}

/** Look up which user owns an instance (used by the webhook). */
export async function emailForInstance(instance: string): Promise<string | null> {
  const rows = await sbSelect<{ email: string }>(
    "wa_sessions",
    `select=email&instance_name=eq.${encodeURIComponent(instance)}&limit=1`
  );
  return rows[0]?.email ?? null;
}

async function saveSession(
  email: string,
  instance: string,
  status: string,
  hostUrl?: string
) {
  await sbInsert(
    "wa_sessions",
    [
      {
        email,
        instance_name: instance,
        status,
        ...(hostUrl ? { host_url: hostUrl } : {}),
        updated_at: new Date().toISOString(),
      },
    ],
    "email"
  );
}

// ---- Idle pause: quiet the session while the user is not using the app ------
//
// WhatsApp shows a linked device as "connected" as long as the pairing exists;
// what makes it feel intrusive is the device appearing ACTIVE around the
// clock. When the app has been idle past the policy window we push presence
// "unavailable" (no online status, no activity), and the first app use flips
// it back - the user never re-pairs.

async function setInstancePresence(email: string, presence: "available" | "unavailable") {
  const instance = instanceNameFor(email);
  await evo(email, `/instance/setPresence/${instance}`, {
    method: "POST",
    body: JSON.stringify({ presence }),
  });
}

/** App-activity heartbeat (called from the status poll while the app is open). */
export async function touchActivity(email: string): Promise<void> {
  try {
    const { sbUpdate } = await import("./runtime-config");
    const rows = await sbSelect<{ idle_paused: boolean | null }>(
      "wa_sessions",
      `select=idle_paused&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
    );
    if (rows[0]?.idle_paused) {
      setInstancePresence(email, "available").catch(() => {});
    }
    await sbUpdate("wa_sessions", `email=eq.${encodeURIComponent(email.toLowerCase())}`, {
      last_active: new Date().toISOString(),
      idle_paused: false,
    });
  } catch {
    /* best-effort */
  }
}

/** Quiet every session idle past the policy window. Returns paused count. */
export async function pauseIdleSessions(): Promise<number> {
  try {
    const { getPolicies } = await import("./wa-guard");
    const { sbUpdate } = await import("./runtime-config");
    const p = await getPolicies();
    const cutoff = new Date(
      Date.now() - Math.max(1, p.idle_pause_hours) * 3600_000
    ).toISOString();
    const idle = await sbSelect<{ email: string }>(
      "wa_sessions",
      `select=email&status=eq.open&idle_paused=eq.false&last_active=lt.${encodeURIComponent(
        cutoff
      )}&limit=10`
    );
    let n = 0;
    for (const row of idle) {
      await setInstancePresence(row.email, "unavailable").catch(() => {});
      await sbUpdate(
        "wa_sessions",
        `email=eq.${encodeURIComponent(row.email.toLowerCase())}`,
        { idle_paused: true }
      );
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Last durable status we recorded for this user's session. */
async function storedStatus(email: string): Promise<string | null> {
  const rows = await sbSelect<{ status: string }>(
    "wa_sessions",
    `select=status&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  return rows[0]?.status ?? null;
}

/** True once the user has successfully paired (and hasn't explicitly logged out). */
export async function wasEverConnected(email: string): Promise<boolean> {
  return (await storedStatus(email)) === "open";
}

/**
 * True if the user has a session row at all (i.e. they went through linking on
 * this or any host). Used by the send path so a transient reconnect is NEVER
 * mistaken for "not connected" - the user is told to wait, never to re-link.
 */
export async function hasSessionRow(email: string): Promise<boolean> {
  const rows = await sbSelect<{ email: string }>(
    "wa_sessions",
    `select=email&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  return rows.length > 0;
}

/** Record that the session is live and paired (never downgraded automatically). */
export async function markOpen(email: string) {
  await saveSession(email, instanceNameFor(email), "open");
}

/**
 * Make sure the session is live, resuming from saved credentials if the
 * connection dropped (Render free tier sleeps/restarts). Returns quickly if
 * already open; otherwise kicks a reconnect and polls within a small budget.
 * Does NOT require the user to re-link as long as their creds are persisted.
 */
export async function ensureConnected(
  email: string,
  budgetMs = 6000
): Promise<{ ok: boolean; state: string | null }> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, state: null };

  let state = await connectionState(email);
  if (state === "open") {
    markOpen(email).catch(() => {});
    return { ok: true, state };
  }

  // If we've failed the user over to a different host, the instance may not
  // exist there yet - creating it makes Evolution load the SHARED creds from
  // the database and reconnect the session (no re-linking needed).
  await evoFetch(host, "/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: instance,
      qrcode: false,
      integration: "WHATSAPP-BAILEYS",
    }),
  });
  // Kick a reconnect on the resolved host.
  await evoFetch(host, `/instance/connect/${instance}`);
  await saveSession(email, instance, "connecting", host.url);

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    state = await connectionState(email);
    if (state === "open") {
      markOpen(email).catch(() => {});
      await saveSession(email, instance, "open", host.url);
      return { ok: true, state };
    }
  }
  return { ok: false, state };
}

/**
 * Create (or reuse) the user's instance and point its webhook at us.
 * Returns a QR code (base64 image) while the session is not yet paired.
 */
export async function connectInstance(
  email: string,
  appOrigin: string,
  phone?: string
): Promise<{
  ok: boolean;
  state?: string;
  qr?: string;
  pairingCode?: string;
  error?: string;
}> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, error: "The WhatsApp connector is not set up yet." };
  const token = await webhookToken();
  const webhookUrl = `${appOrigin}/api/webhooks/evolution?token=${token}`;
  const digits = (phone ?? "").replace(/[^\d]/g, "");

  // NEVER destroy an already-linked session. If the instance is already open,
  // the user has connected - return that instead of wiping it (this was the
  // cause of "WhatsApp says linked but the app keeps asking to connect": a
  // re-entry into connect() deleted the fresh session).
  const existing = await connectionState(email);
  if (existing === "open") {
    await markOpen(email);
    return { ok: true, state: "open" };
  }

  // Otherwise start from a CLEAN slate. A leftover half-linked instance (from a
  // previous attempt, common in the signup funnel) hands WhatsApp a stale
  // pairing code, which WhatsApp rejects as "Incorrect code". Deleting first
  // guarantees the code we show is the current, valid one.
  await evoFetch(host, `/instance/logout/${instance}`, { method: "DELETE" });
  await evoFetch(host, `/instance/delete/${instance}`, { method: "DELETE" });
  await new Promise((r) => setTimeout(r, 600));

  // Anti-ban instance hardening (from the WhatsApp ban-vector research):
  //  - always_online:false  -> the device NEVER shows as permanently online
  //    (this is the root cause of "always connected"; presence is driven only
  //    while the app is in use).
  //  - markMessagesRead:false-> we never auto-read the user's other chats.
  //  - groupsIgnore:true     -> group traffic is dropped (privacy + less noise).
  //  - a residential proxy (if configured) routes the WebSocket through a
  //    non-datacenter IP - datacenter IPs are a top-weighted ban signal.
  const proxy = await parseProxy(email);
  const hardening = {
    rejectCall: false,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    // History sync ON so the owner can teach the agents from past bargains
    // (the import reads only the numbers you name). It is a one-time read, not
    // a ban vector; always_online/proxy are the protections that matter.
    syncFullHistory: true,
  };
  const events = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"];

  // Pairing code needs the number PASSED AT CREATE time in Evolution v2 - the
  // create response then carries the pairing code directly.
  const createBody: Record<string, unknown> = {
    instanceName: instance,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    alwaysOnline: false,
    groupsIgnore: true,
    readMessages: false,
    readStatus: false,
    syncFullHistory: true,
    ...(proxy ? { proxyHost: proxy.host, proxyPort: proxy.port, proxyProtocol: proxy.protocol, proxyUsername: proxy.username, proxyPassword: proxy.password } : {}),
    webhook: { url: webhookUrl, byEvents: false, events },
  };
  if (digits) createBody.number = digits;

  let created = await evoFetch(host, "/instance/create", {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  if (!created.ok && created.status !== 403 && created.status !== 409) {
    // Older Evolution builds use a flat webhook field - retry once.
    created = await evoFetch(host, "/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        ...(digits ? { number: digits } : {}),
        webhook: webhookUrl,
        events: ["MESSAGES_UPSERT"],
      }),
    });
    if (!created.ok && created.status !== 403 && created.status !== 409) {
      return {
        ok: false,
        error:
          created.data?.response?.message?.toString?.() ??
          created.data?.message ??
          created.data?.error ??
          `Evolution API ${created.status} - check the URL + API key in Admin.`,
      };
    }
  }

  // Make sure the webhook is set even for pre-existing instances.
  await evoFetch(host, `/webhook/set/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: { enabled: true, url: webhookUrl, byEvents: false, events },
      enabled: true,
      url: webhookUrl,
      events,
    }),
  });

  // Apply the hardening settings (also covers pre-existing instances). Best
  // effort - older Evolution builds ignore unknown fields.
  await evoFetch(host, `/settings/set/${instance}`, {
    method: "POST",
    body: JSON.stringify(hardening),
  }).catch(() => {});
  if (proxy) {
    await evoFetch(host, `/proxy/set/${instance}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, ...proxy }),
    }).catch(() => {});
  }

  const pickPairing = (d: any): string | undefined => {
    const raw = d?.pairingCode ?? d?.qrcode?.pairingCode ?? d?.instance?.pairingCode;
    return typeof raw === "string" && /^[A-Za-z0-9]{3,}-?[A-Za-z0-9]{0,}$/.test(raw) && raw.length <= 12
      ? raw
      : undefined;
  };
  const pickQr = (d: any): string | undefined =>
    d?.base64 ??
    d?.qrcode?.base64 ??
    (typeof d?.code === "string" && d.code.startsWith("data:") ? d.code : undefined);

  // The pairing code may already be in the create response (Evolution v2 with
  // number passed at create).
  let pairingCode = pickPairing(created.data);
  let qr = pickQr(created.data);

  // Otherwise poll the connect endpoint a few times. Baileys sometimes needs a
  // moment to mint the code; we DON'T recreate the instance (that would
  // invalidate an already-shown code and cause "couldn't link device").
  const attempts = digits ? 4 : 1;
  for (let i = 0; i < attempts && !pairingCode; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1400));
    const conn = await evoFetch(
      host,
      `/instance/connect/${instance}${digits ? `?number=${digits}` : ""}`
    );
    pairingCode = pairingCode ?? pickPairing(conn.data);
    qr = qr ?? pickQr(conn.data);
  }

  const state = await connectionState(email);
  await saveSession(email, instance, state ?? "connecting", host.url);

  return {
    ok: true,
    state: state ?? "connecting",
    qr,
    pairingCode,
    error:
      !pairingCode && !qr
        ? "Couldn't get a code yet - your Render (Evolution) server may be waking up. Wait ~30 seconds and tap Try again."
        : !pairingCode && qr
        ? "Code not available right now - use the QR tab from a computer, or tap Try again."
        : undefined,
  };
}

/** Force a brand-new session (used by the 'New code' button when linking fails). */
export async function resetInstance(email: string): Promise<void> {
  const instance = instanceNameFor(email);
  await evo(email, `/instance/logout/${instance}`, { method: "DELETE" });
  await evo(email, `/instance/delete/${instance}`, { method: "DELETE" });
  await saveSession(email, instance, "disconnected");
}

/** True when this number is actually on WhatsApp (checked via the session). */
export async function numberOnWhatsApp(
  email: string,
  number: string
): Promise<boolean | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/chat/whatsappNumbers/${instance}`, {
    method: "POST",
    body: JSON.stringify({ numbers: [number.replace(/[^\d]/g, "")] }),
  });
  if (!res.ok || !Array.isArray(res.data)) return null; // unknown - don't block
  return Boolean(res.data[0]?.exists ?? res.data[0]?.numberExists);
}

// ---- Chat history (for auto-teaching the bargaining agents) --------------------

export interface WaChat {
  jid: string;
  name?: string;
}

/** List the user's individual (non-group) chats. */
export async function fetchChats(email: string): Promise<WaChat[]> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/chat/findChats/${instance}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const arr: any[] = Array.isArray(res.data) ? res.data : res.data?.chats ?? [];
  return arr
    .map((c) => ({
      jid: String(c.remoteJid ?? c.id ?? c.jid ?? ""),
      name: c.pushName ?? c.name ?? c.subject ?? undefined,
    }))
    .filter((c) => c.jid.endsWith("@s.whatsapp.net")); // individuals only, no groups
}

export interface WaMessage {
  fromMe: boolean;
  text: string;
  ts: number;
}

/**
 * Resolve a pasted phone number to the exact JID WhatsApp stores for it. This
 * fixes "no chat found" when the owner types the number in a slightly different
 * format than WhatsApp's canonical one (e.g. a leading 0, a missing country
 * code, or the new @lid privacy JIDs).
 */
export async function resolveChatJid(
  email: string,
  rawNumber: string
): Promise<string | null> {
  const digits = rawNumber.replace(/[^\d]/g, "");
  if (digits.length < 7) return null;
  const instance = instanceNameFor(email);
  // 1) Ask WhatsApp for the canonical JID of this number.
  try {
    const res = await evo(email, `/chat/whatsappNumbers/${instance}`, {
      method: "POST",
      body: JSON.stringify({ numbers: [digits] }),
    });
    const jid = res.data?.[0]?.jid ?? res.data?.[0]?.remoteJid;
    if (typeof jid === "string" && jid.includes("@")) return jid;
  } catch {
    /* fall through */
  }
  // 2) Otherwise match against the synced chat list by trailing digits.
  try {
    const chats = await fetchChats(email);
    const tail = digits.slice(-9);
    const hit = chats.find((c) => c.jid.replace(/[^\d]/g, "").endsWith(tail));
    if (hit) return hit.jid;
  } catch {
    /* fall through */
  }
  // 3) Best-effort default form.
  return `${digits}@s.whatsapp.net`;
}

/** Recent messages of one chat, oldest-first. */
export async function fetchMessages(
  email: string,
  jid: string,
  limit = 60
): Promise<WaMessage[]> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/chat/findMessages/${instance}`, {
    method: "POST",
    body: JSON.stringify({ where: { key: { remoteJid: jid } }, limit }),
  });
  const arr: any[] = Array.isArray(res.data)
    ? res.data
    : res.data?.messages?.records ?? res.data?.messages ?? res.data?.records ?? [];
  return arr
    .map((m) => {
      const msg = m.message ?? {};
      const text =
        msg.conversation ??
        msg.extendedTextMessage?.text ??
        msg.imageMessage?.caption ??
        "";
      return {
        fromMe: Boolean(m.key?.fromMe),
        text: String(text),
        ts: Number(m.messageTimestamp ?? 0),
      };
    })
    .filter((m) => m.text.trim().length > 0)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Download an inbound media message (a price-list photo) as base64 so the
 * vision agent can read the prices off it. Evolution v2 exposes
 * getBase64FromMediaMessage; returns { base64, mime } or null.
 */
export async function fetchMediaBase64(
  email: string,
  message: unknown
): Promise<{ base64: string; mime: string } | null> {
  const instance = instanceNameFor(email);
  try {
    const res = await evo(email, `/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      body: JSON.stringify({ message, convertToMp4: false }),
    });
    const base64 = res.data?.base64 ?? res.data?.media ?? res.data?.buffer;
    const mime = res.data?.mimetype ?? res.data?.mimeType ?? "image/jpeg";
    if (typeof base64 === "string" && base64.length > 100) {
      return { base64: base64.replace(/^data:[^,]+,/, ""), mime };
    }
  } catch {
    /* media fetch is best-effort */
  }
  return null;
}

/**
 * Read the state directly off Evolution's instance list. Right after a
 * pairing-code link the dedicated /connectionState endpoint is often still
 * "connecting" (stale cache) while fetchInstances already reports "open" - so
 * we cross-check both. Returns "open" | "connecting" | "close" | null.
 */
async function stateFromFetchInstances(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/instance/fetchInstances?instanceName=${instance}`);
  if (!res.ok) return null;
  const arr: any[] = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  // Evolution v2 shapes vary: [{ name, connectionStatus }] or
  // [{ instance: { instanceName, state|status } }].
  const match =
    arr.find(
      (x) =>
        x?.name === instance ||
        x?.instanceName === instance ||
        x?.instance?.instanceName === instance ||
        x?.instance?.name === instance
    ) ?? arr[0];
  if (!match) return null;
  const raw =
    match.connectionStatus ??
    match.state ??
    match.status ??
    match.instance?.state ??
    match.instance?.status ??
    match.instance?.connectionStatus ??
    null;
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  return s === "connected" ? "open" : s;
}

/** "open" = paired and ready to send. Cross-checks both Evolution endpoints. */
export async function connectionState(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/instance/connectionState/${instance}`);
  let state: string | null = res.ok
    ? res.data?.instance?.state ?? res.data?.state ?? null
    : null;
  // If the dedicated endpoint is not already "open", ask the instance list -
  // it reflects a fresh pairing-code link faster. This is the fix for
  // "WhatsApp says linked but the app still says NOT CONNECTED".
  if (state !== "open") {
    const alt = await stateFromFetchInstances(email);
    if (alt === "open") state = "open";
    else if (!state && alt) state = alt;
  }
  if (state === "open") markOpen(email).catch(() => {});
  return state;
}

/**
 * Fully sever our link to the user's WhatsApp. Logs out and DELETES the instance
 * on EVERY host (so no server keeps a live socket) and on the shared database
 * (so the Baileys credentials are gone), then removes our own wa_sessions record
 * entirely - we retain nothing about their WhatsApp afterwards.
 */
export async function disconnectInstance(email: string): Promise<boolean> {
  const instance = instanceNameFor(email);
  const hosts = await getHosts();
  let ok = false;
  for (const h of hosts) {
    await evoFetch(h, `/instance/logout/${instance}`, { method: "DELETE" });
    const res = await evoFetch(h, `/instance/delete/${instance}`, { method: "DELETE" });
    ok = ok || res.ok;
  }
  await sbDelete("wa_sessions", `email=eq.${encodeURIComponent(email.toLowerCase())}`);
  return ok;
}

/** Send a text from the user's own WhatsApp (rate-limited, human-like).
 *  `fast` skips the blocking presence-mimicry wait so the API returns quickly
 *  (used for interactive sends where the UI needs to feel instant; a short
 *  typing indicator still fires, and the guard already spaced the message). */
export async function sendFromUser(
  email: string,
  to: string,
  message: string,
  fast = false
): Promise<{ ok: boolean; error?: string; rateLimited?: boolean }> {
  const rate = await checkRateLimit(email);
  if (!rate.allowed) return { ok: false, rateLimited: true, error: rate.reason };

  const instance = instanceNameFor(email);
  const number = to.replace(/[^\d]/g, "");

  // Resume the session if it dropped, instead of failing outright.
  const conn = await ensureConnected(email, 6000);
  if (!conn.ok) {
    // A session row means the user HAS linked - a failed resume is a transient
    // reconnect (Render waking), never a reason to make them re-link.
    const paired = await hasSessionRow(email);
    return {
      ok: false,
      error: paired ? "reconnecting" : "not-connected",
    };
  }
  // We reached the socket live: persist "open" so wasEverConnected stays true
  // durably and future sends never regress to "not connected".
  markOpen(email).catch(() => {});

  // Presence mimicry (anti-ban): show a "typing…" indicator before the message.
  // FAST path (interactive sends) fires the indicator but does NOT block on the
  // full multi-step wait, so the UI feels instant; the anti-ban GAP between
  // messages is already enforced by the guard. SLOW path (queued/background
  // sends) does the full human-like composing -> pause -> composing sequence.
  try {
    const { getPolicies } = await import("./wa-guard");
    const p = await getPolicies();
    const span = Math.max(0, p.presence_max_ms - p.presence_min_ms);
    const presence = (state: string, delay: number) =>
      evo(email, `/chat/sendPresence/${instance}`, {
        method: "POST",
        body: JSON.stringify({ number, presence: state, delay }),
      });
    if (fast) {
      // One short typing burst, no blocking wait beyond ~1.2s.
      await presence("composing", 1500);
      await new Promise((r) => setTimeout(r, 900 + Math.floor(Math.random() * 500)));
    } else {
      const t1 = p.presence_min_ms + Math.floor(Math.random() * span * 0.6);
      const pause = 600 + Math.floor(Math.random() * 1400);
      const t2 = Math.min(4000, 900 + Math.floor(message.length * (18 + Math.random() * 22)) / 4);
      await presence("composing", t1);
      await new Promise((r) => setTimeout(r, Math.min(t1, 5000)));
      await presence("paused", pause);
      await new Promise((r) => setTimeout(r, pause));
      await presence("composing", t2);
      await new Promise((r) => setTimeout(r, Math.min(t2, 4000)));
    }
  } catch {
    /* presence is cosmetic - never block the send */
  }

  const trySend = async () => {
    // v2 shape first, then the legacy v1 body.
    let r = await evo(email, `/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number, text: message, delay: TYPING_DELAY_MS() }),
    });
    if (!r.ok) {
      r = await evo(email, `/message/sendText/${instance}`, {
        method: "POST",
        body: JSON.stringify({
          number,
          options: { delay: TYPING_DELAY_MS(), presence: "composing" },
          textMessage: { text: message },
        }),
      });
    }
    return r;
  };

  // Send with one reconnect-and-retry on failure.
  let res = await trySend();
  if (!res.ok) {
    await evo(email, `/instance/connect/${instance}`);
    await new Promise((r) => setTimeout(r, 1200));
    res = await trySend();
  }
  if (res.ok) {
    recordSend(email);
    return { ok: true };
  }
  const errText =
    res.data?.response?.message?.toString?.() ??
    res.data?.message ??
    res.data?.error ??
    `Evolution API ${res.status}`;
  // A send failure to a number that is not on WhatsApp (or that blocked us)
  // looks like list-blasting to Meta - feed it to the risk engine so the
  // number's ban-risk score reflects it.
  try {
    const { recordSendFailure } = await import("./wa-guard");
    const blocked = /not.*whatsapp|invalid|exist|blocked|forbidden/i.test(String(errText));
    await recordSendFailure(email, number, blocked ? "block" : "fail");
  } catch {
    /* best-effort */
  }
  return { ok: false, error: errText };
}
