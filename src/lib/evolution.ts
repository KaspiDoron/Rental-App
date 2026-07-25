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
import { getConfig, sbInsert, sbSelect, sbDelete, sbSelectStrict } from "./runtime-config";
import { deriveWebhookToken, sameWebhookTarget } from "./wa/webhook-token";
import { jidMatches } from "./wa/jid";
import { isLinkedFromStatus } from "./wa/linked-status";
import { digitsOnly } from "./phone";

// ---- anti-ban limits (human-like behaviour; owner-adjustable in Admin) --------
const MIN_GAP_MS = 20_000; // never two messages within 20s per user

// PAIRING-LAYER anti-ban: the client fingerprint presented at socket connect.
// Baileys' default fingerprint (a generic "Evolution API" / library string) reads
// as an automation client and is a top-weighted flag vector AT PAIRING TIME -
// before a single message is sent (the exact failure the owner hit). Presenting a
// STANDARD desktop WhatsApp-Web fingerprint (Chrome on macOS) makes the socket
// indistinguishable from a normal linked-device Web session.
//   [platform, browser, version] - Baileys' Browsers.macOS('Chrome') shape.
// Passed on EVERY instance/create below. On stock Evolution API the authoritative
// equivalent is the SERVER env CONFIG_SESSION_PHONE_CLIENT="Mac OS" +
// CONFIG_SESSION_PHONE_NAME="Chrome" (see docs/ANTI-BAN.md); setting both the
// per-instance field AND the server env is belt-and-suspenders - the field is a
// harmless no-op on builds that read only the env, and authoritative on forks
// that pass `browser` straight to makeWASocket.
const CLIENT_BROWSER: readonly [string, string, string] = ["Mac OS", "Chrome", "122.0.0"];

// Connection-safety defaults shared by every instance/create path. mobile:false
// pins the WhatsApp WEB protocol (not the flagged/deprecated mobile API); the
// history/read flags below keep the socket from pulling the user's past chats or
// media on connect (data minimization AND removing the "reads everything on link"
// bot signature). NOTE: syncFullHistory:false is intentionally ALSO written as a
// literal in each create body - the hardening-invariants test pins that literal.
const CONNECT_FINGERPRINT = { browser: CLIENT_BROWSER, mobile: false } as const;

// A per-message "typing" duration that scales with message length, jittered so
// it is never a flat constant (a faint machine tell). ~18ms/char lands a 40-char
// reply near ~1.9s and a 180-char paragraph near ~4.4s, and it is CAPPED at 4.5s.
// The cap matters for more than realism: Evolution honours this `delay` by
// holding the send request server-side, and evoFetch aborts at 12s - so the hold
// must stay well under that budget or a slow host would time out (status 0) mid
// send. 4.5s leaves ~7.5s of headroom for the actual network round-trip.
const typingDelayForLength = (len: number): number => {
  const base = 1200 + Math.max(0, len) * 18;
  const jittered = base * (0.9 + Math.random() * 0.2);
  return Math.round(Math.max(1200, Math.min(4500, jittered)));
};

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
    `select=id,received_at&direction=eq.outbound&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
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

/** Webhook token derived from a stable secret so it works across all hosts.
 * Derivation lives in the pure `wa/webhook-token` module (unit-tested); this
 * wrapper keeps the no-hosts gate. There is deliberately NO previous-secret
 * acceptance - the fix for a rotated secret is to RE-ARM Evolution's stored URL
 * with the current token (reassertWebhook), not to accept stale tokens. */
export async function webhookToken(): Promise<string | null> {
  if ((await getHosts()).length === 0) return null;
  return deriveWebhookToken({ secret: process.env.SESSION_SECRET, nodeEnv: process.env.NODE_ENV });
}

/** The canonical public origin the webhook must point at. The admin-set
 * APP_DOMAIN (the GCP gateway URL) WINS over the request origin, so a
 * preview/tap-time origin can never get baked into Evolution. Returns null when
 * neither resolves (caller skips the re-arm). */
export async function canonicalWebhookOrigin(requestOrigin?: string): Promise<string | null> {
  const norm = (s?: string | null): string | null => {
    if (!s) return null;
    let v = s.trim();
    if (!v) return null;
    if (!/^https?:\/\//.test(v)) v = `https://${v}`;
    try {
      return new URL(v).origin;
    } catch {
      return null;
    }
  };
  const configured = await getConfig("APP_DOMAIN").catch(() => null);
  return norm(configured) ?? norm(requestOrigin) ?? null;
}

// Per-instance re-arm throttle (in-memory, survives warm invocations).
declare global {
  // eslint-disable-next-line no-var
  var __wd_wh_rearm__: Map<string, number> | undefined;
}
function rearmStore(): Map<string, number> {
  if (!globalThis.__wd_wh_rearm__) globalThis.__wd_wh_rearm__ = new Map();
  return globalThis.__wd_wh_rearm__;
}
const REARM_THROTTLE_MS = 60 * 60 * 1000; // ~1h per instance unless forced

/**
 * Re-assert the user's webhook URL on Evolution with the CURRENT token, WITHOUT
 * touching the session. This is the fix for a rotated SESSION_SECRET (Evolution
 * still holds a URL with the old token) and for preview-origin pairings. It ONLY
 * ever calls GET /webhook/find + POST /webhook/set - never instance
 * create/logout/delete - so it can never break the working outbound path. Every
 * Evolution call is guarded; read-before-write skips the set when the canonical
 * URL is already registered.
 */
export async function reassertWebhook(
  email: string,
  opts: { requestOrigin?: string; force?: boolean } = {}
): Promise<{
  ok: boolean;
  changed: boolean;
  registeredUrl: string | null;
  skipped?: "no-origin" | "no-host" | "throttled";
}> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, changed: false, registeredUrl: null, skipped: "no-host" };

  const origin = await canonicalWebhookOrigin(opts.requestOrigin);
  if (!origin) return { ok: false, changed: false, registeredUrl: null, skipped: "no-origin" };

  const store = rearmStore();
  const now = Date.now();
  if (!opts.force && now - (store.get(instance) ?? 0) < REARM_THROTTLE_MS) {
    return { ok: true, changed: false, registeredUrl: null, skipped: "throttled" };
  }
  store.set(instance, now);

  const token = await webhookToken();
  if (!token) return { ok: false, changed: false, registeredUrl: null, skipped: "no-host" };
  const webhookUrl = `${origin}/api/webhooks/evolution?token=${token}`;
  const events = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"];

  // Read-before-write: don't churn a healthy instance.
  let registeredUrl: string | null = null;
  try {
    const found = await evoFetch(host, `/webhook/find/${instance}`);
    registeredUrl =
      (typeof found.data?.url === "string" && found.data.url) ||
      (typeof found.data?.webhook?.url === "string" && found.data.webhook.url) ||
      null;
  } catch {
    /* proceed to set */
  }
  if (registeredUrl && sameWebhookTarget(registeredUrl, origin, token)) {
    return { ok: true, changed: false, registeredUrl };
  }

  // ONLY /webhook/set - never touch the session.
  const set = await evoFetch(host, `/webhook/set/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: { enabled: true, url: webhookUrl, byEvents: false, events },
      enabled: true,
      url: webhookUrl,
      events,
    }),
  }).catch(() => ({ ok: false, status: 0, data: {} }));

  // Visibility when APP_DOMAIN overrode a different request origin.
  if (opts.requestOrigin) {
    try {
      if (new URL(opts.requestOrigin).origin !== origin) {
        await sbInsert("agent_events", [
          {
            kind: "webhook-origin-override",
            vendor_id: "",
            vendor_name: instance,
            detail: `Re-armed webhook to ${origin} (request origin was ${new URL(opts.requestOrigin).origin}).`,
          },
        ]).catch(() => {});
      }
    } catch {
      /* non-fatal */
    }
  }

  return { ok: set.ok, changed: set.ok, registeredUrl: set.ok ? webhookUrl : registeredUrl };
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
      detail = `Server error HTTP ${res.status} - Evolution is crashing. Known causes: the OnWhatsappCache/Prisma bug (fix: redeploy the updated render.yaml Blueprint - it adds Redis + DATABASE_SAVE_IS_ON_WHATSAPP=false) or a bad DATABASE_CONNECTION_URI.`;
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
  // HARD TIMEOUT. undici's fetch has no short overall request timeout, so a
  // cold/asleep Evolution host (Render free tier) could hang the caller until
  // Vercel kills the whole function - which, on the drain path, permanently
  // LOSES an already-claimed outbox row. Bounding every call well under the 60s
  // function limit turns a fatal hang into a transient failure the drain
  // re-queues. The sibling probes (hostHealthDetail 4.5s, pingAllHosts 7s)
  // already do this; the actual send/connect path must too.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${host.url}${path}`, {
      ...init,
      signal: ctrl.signal,
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
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      data: { error: aborted ? "evolution host timed out (12s)" : e instanceof Error ? e.message : "network error" },
    };
  } finally {
    clearTimeout(timer);
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

/** Real-world WhatsApp pairing codes die in about a minute. The app treats a
 *  shown code as live for this long; past it, any retry takes the hard
 *  logout+delete+recreate path so the user always types a CURRENT code. */
export const PAIRING_TTL_MS = 55_000;

async function saveSession(
  email: string,
  instance: string,
  status: string,
  hostUrl?: string,
  pairingIssuedAt?: Date | null
) {
  await sbInsert(
    "wa_sessions",
    [
      {
        // ALWAYS lowercased: every read (hasSessionRow, storedStatus,
        // resolveHost) queries email=eq.<lowercase>. A mixed-case email (e.g.
        // from Google sign-in) written raw made a truly-connected user look
        // "not connected" to the import/teach features.
        email: email.trim().toLowerCase(),
        instance_name: instance,
        status,
        ...(hostUrl ? { host_url: hostUrl } : {}),
        ...(pairingIssuedAt !== undefined
          ? { pairing_code_issued_at: pairingIssuedAt ? pairingIssuedAt.toISOString() : null }
          : {}),
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

/**
 * Last durable status we recorded for this user's session. Returns the sentinel
 * "unknown" when the store is UNREACHABLE (transient Supabase blip) so callers
 * can fail SAFE and never mistake a DB hiccup for "never linked" - the old
 * sbSelect collapsed every error to [] -> null -> "not connected".
 */
async function storedStatus(email: string): Promise<string | null> {
  // EXACT match on the lowercased email. saveSession ALWAYS writes
  // email.trim().toLowerCase() (see its comment), so rows are guaranteed
  // lowercase and eq. is correct. The old `ilike.` was a cross-user hazard: an
  // underscore in one user's email is a single-char SQL wildcard, so
  // `a_b@x.com` could match a DIFFERENT registered user `axb@x.com` and return
  // their linked state.
  const res = await sbSelectStrict<{ status: string }>(
    "wa_sessions",
    `select=status&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&limit=1`
  );
  if ("error" in res) return res.error === "unavailable" ? "unknown" : null;
  return res.rows[0]?.status ?? null;
}

/** True once the user has successfully paired (and hasn't explicitly logged out). */
export async function wasEverConnected(email: string): Promise<boolean> {
  return (await storedStatus(email)) === "open";
}

/**
 * Linked FOR THE UI: the user completed pairing at least once (durable status
 * "open"), OR the store is momentarily unreachable (fail SAFE - a DB blip must
 * never push a genuinely-paired user to re-link). A mere "connecting" row
 * (connectInstance handed out a pairing code but the socket never opened) is
 * explicitly NOT linked. hasSessionRow returns true for ANY row including that
 * "connecting" one, which made /api/wa/status report connected=true on the
 * first 3s poll of a first-time pairing - clearing the code before the user
 * could enter it and stranding them "linked but never open". The status/health
 * UI must use THIS, not raw row existence.
 */
export async function isLinkedForUi(email: string): Promise<boolean> {
  return isLinkedFromStatus(await storedStatus(email));
}

/**
 * True if the user has a session row at all (i.e. they went through linking on
 * this or any host). Used by the send/status paths so a transient reconnect is
 * NEVER mistaken for "not connected" - the user is told to wait, never to
 * re-link. FAILS SAFE: on an unreachable store it returns true (assume still
 * linked), so a Supabase blip can never tell a paired user to re-link.
 */
export async function hasSessionRow(email: string): Promise<boolean> {
  const res = await sbSelectStrict<{ email: string }>(
    "wa_sessions",
    `select=email&email=eq.${encodeURIComponent(email.trim().toLowerCase())}&limit=1`
  );
  if ("error" in res) return res.error === "unavailable"; // unavailable -> assume linked
  return res.rows.length > 0;
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
  //
  // CRITICAL: this recreate MUST carry the webhook, or a host restart silently
  // recreates a webhook-LESS instance (outbound keeps working, inbound stops).
  // Resolve the canonical origin (APP_DOMAIN - the GCP gateway) + current token.
  const recreateOrigin = await canonicalWebhookOrigin();
  const recreateToken = await webhookToken();
  const recreateEvents = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"];
  const recreateWebhook =
    recreateOrigin && recreateToken
      ? {
          webhook: {
            url: `${recreateOrigin}/api/webhooks/evolution?token=${recreateToken}`,
            byEvents: false,
            events: recreateEvents,
          },
        }
      : {};
  await evoFetch(host, "/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: instance,
      qrcode: false,
      integration: "WHATSAPP-BAILEYS",
      // Standard Chrome-on-macOS fingerprint + web protocol on the failover
      // recreate too, so a reconnect never re-links under the flagged default.
      ...CONNECT_FINGERPRINT,
      // Privacy: never backfill the user's full personal history on a failover
      // recreate either (data minimization must be set at create time on EVERY
      // instance/create path, not applied post-hoc via a best-effort settings call).
      syncFullHistory: false,
      ...recreateWebhook,
    }),
  });
  // Kick a reconnect on the resolved host.
  await evoFetch(host, `/instance/connect/${instance}`);
  // NEVER regress a durable "open" to "connecting" on a failed/unknown probe:
  // a transient host outage must not make a linked user read as "never
  // connected" (wasEverConnected == status "open"). Only record "connecting"
  // when we are not already durably open. The success branch below still
  // writes "open" when the socket returns; if it never returns, the row
  // correctly stays "open" = still-linked (genuine unlink goes through the
  // explicit logout/ban paths, never this transient one).
  const prior = await storedStatus(email);
  // A null stored status means the user is NOT linked (never paired, or just
  // disconnected). A background drain must NEVER mint a "connecting" session for
  // them - that resurrected a torn-down link. Only ever record "connecting" for
  // a session that genuinely exists and is not already durably open/unknown.
  if (prior === null) return { ok: false, state };
  if (prior !== "open" && prior !== "unknown") {
    await saveSession(email, instance, "connecting", host.url);
  }

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    state = await connectionState(email);
    if (state === "open") {
      markOpen(email).catch(() => {});
      await saveSession(email, instance, "open", host.url);
      // Ensure the reconnected instance points at the current webhook URL
      // (throttled; find+set only - never re-arms more than ~1/hour/instance).
      reassertWebhook(email).catch(() => {});
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
  /** Milliseconds the returned pairing code is still expected to be valid. */
  pairingExpiresInMs?: number;
  /** True when the Evolution host itself is down/restarting (crash-loop, not a
   *  user problem) - the client shows an honest "server restarting" state. */
  hostDown?: boolean;
  error?: string;
}> {
  const instance = instanceNameFor(email);
  const host = await resolveHost(email);
  if (!host) return { ok: false, error: "The WhatsApp connector is not set up yet." };

  // HONESTY GATE (B1): with a single host there is no failover, and resolveHost
  // skips probing - so probe HERE. Pairing against a crash-looping server just
  // mints codes that die mid-handshake with zero signal; tell the user the
  // truth instead of showing an undifferentiated timeout.
  {
    const health = await hostHealthDetail(host);
    if (!health.ok) {
      return {
        ok: false,
        hostDown: true,
        error:
          "Our WhatsApp server is restarting right now - nothing is wrong on your side. Give it a minute, then tap Try again.",
      };
    }
  }
  const token = await webhookToken();
  const webhookUrl = `${appOrigin}/api/webhooks/evolution?token=${token}`;
  const digits = digitsOnly(phone);

  // NEVER destroy an already-linked session. If the instance is already open,
  // the user has connected - return that instead of wiping it (this was the
  // cause of "WhatsApp says linked but the app keeps asking to connect": a
  // re-entry into connect() deleted the fresh session).
  const existing = await connectionState(email);
  if (existing === "open") {
    await markOpen(email);
    // RE-ARM the webhook even for an already-open instance: this is the only
    // non-destructive path to refresh a stale URL (secret rotation / a
    // preview-origin pairing) without wiping the live session. find+set only.
    await reassertWebhook(email, { requestOrigin: appOrigin, force: true }).catch(() => {});
    return { ok: true, state: "open" };
  }

  // A pairing that started SECONDS ago is mid-handshake, not stale. A second
  // Connect tap (very common in the signup funnel: impatient double-tap, a
  // re-render, a refocused tab) used to logout+delete the in-progress
  // instance - destroying the exact pairing the phone was about to complete
  // ("my WhatsApp disconnected by itself"). While the SHOWN CODE is still
  // inside its real ~55s validity window we RE-POLL the same instance instead
  // of wiping it. Past the TTL the old 90s grace was actively harmful: it
  // handed back the SAME dead code ("Invalid code, try again") - so an
  // expired code now always falls through to the clean hard reset below.
  let codeAgeMs = NaN;
  if (existing === "connecting") {
    const row = await sbSelect<{ updated_at: string | null; pairing_code_issued_at?: string | null }>(
      "wa_sessions",
      `select=updated_at,pairing_code_issued_at&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
    ).catch(() => []);
    const issued = row[0]?.pairing_code_issued_at ?? row[0]?.updated_at;
    const startedMs = issued ? Date.parse(issued) : NaN;
    codeAgeMs = Number.isFinite(startedMs) ? Date.now() - startedMs : NaN;
    if (Number.isFinite(codeAgeMs) && codeAgeMs < PAIRING_TTL_MS) {
      const conn = await evoFetch(
        host,
        `/instance/connect/${instance}${digits ? `?number=${digits}` : ""}`
      );
      const rawPairing =
        conn.data?.pairingCode ?? conn.data?.qrcode?.pairingCode ?? conn.data?.instance?.pairingCode;
      const pairing =
        typeof rawPairing === "string" &&
        /^[A-Za-z0-9]{3,}-?[A-Za-z0-9]{0,}$/.test(rawPairing) &&
        rawPairing.length <= 12
          ? rawPairing
          : undefined;
      const qrNow =
        conn.data?.base64 ??
        conn.data?.qrcode?.base64 ??
        (typeof conn.data?.code === "string" && conn.data.code.startsWith("data:")
          ? conn.data.code
          : undefined);
      // The state may have flipped to open while we polled - honor it.
      const nowState = await connectionState(email);
      if (nowState === "open") {
        await markOpen(email);
        return { ok: true, state: "open" };
      }
      if (pairing || qrNow) {
        return {
          ok: true,
          state: "connecting",
          qr: qrNow,
          pairingCode: pairing,
          // Remaining life of the ALREADY-issued code, not a fresh window.
          pairingExpiresInMs: Math.max(1_000, PAIRING_TTL_MS - codeAgeMs),
        };
      }
      // No code from the live handshake - fall through to the clean recreate
      // (the pairing is likely genuinely wedged).
    }
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
    // PRIVACY / DATA MINIMISATION: do NOT backfill the user's entire WhatsApp
    // history into the Evolution store. We only ever need the LIVE messages of
    // the rental-shop threads the agent opened; keeping the full personal
    // history out of the store shrinks the blast radius of any future scoping
    // bug to near zero (the per-message JID filter is the primary guard). The
    // teaching import still reads recent messages of numbers the owner names.
    syncFullHistory: false,
  };
  const events = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"];

  // Pairing code needs the number PASSED AT CREATE time in Evolution v2 - the
  // create response then carries the pairing code directly.
  const createBody: Record<string, unknown> = {
    instanceName: instance,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    // PAIRING-LAYER defense: present a standard Chrome-on-macOS Web fingerprint
    // and pin the web protocol, so the socket does not get flagged at connect
    // time (the ban happened BEFORE any message - at pairing).
    ...CONNECT_FINGERPRINT,
    alwaysOnline: false,
    groupsIgnore: true,
    readMessages: false,
    readStatus: false,
    // Privacy: do NOT backfill the user's entire personal WhatsApp history into
    // the store at link time. Same rationale as the hardening object below -
    // keep only the rental-shop threads the agent opens; the per-message JID
    // filter is the primary guard, this shrinks the blast radius to near zero.
    syncFullHistory: false,
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
        // NOTE: the fingerprint fields (browser/mobile) are DELIBERATELY omitted
        // here. This retry is the LAST-RESORT minimal body: it fires when the
        // main create failed with a non-403/409 status, which on a strict build
        // could be a 400 rejecting the very browser/mobile fields. Keeping this
        // path fingerprint-free means such a build can still pair via the legacy
        // shape (those builds read the fingerprint from server env anyway -
        // CONFIG_SESSION_PHONE_CLIENT/NAME, per docs/ANTI-BAN.md).
        // Privacy: the flat-retry path fires precisely BECAUSE this is an older
        // Evolution build - the exact build whose comment below admits it
        // ignores the post-hoc /settings/set hardening. So syncFullHistory
        // MUST be declared here at create time, or the user's entire personal
        // WhatsApp history gets backfilled into the shared store on a fresh link.
        syncFullHistory: false,
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
  // Stamp WHEN this fresh code was minted so retries can tell live from dead
  // (the whole B1 "Invalid code" class). No code -> clear the stamp.
  await saveSession(
    email,
    instance,
    state ?? "connecting",
    host.url,
    pairingCode ? new Date() : null
  );

  return {
    ok: true,
    state: state ?? "connecting",
    qr,
    pairingCode,
    ...(pairingCode ? { pairingExpiresInMs: PAIRING_TTL_MS } : {}),
    error:
      !pairingCode && !qr
        ? "The WhatsApp server didn't hand out a code - wait ~30 seconds and tap Try again."
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
    body: JSON.stringify({ numbers: [digitsOnly(number)] }),
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

// Pull readable text out of ANY Evolution/Baileys message object. WhatsApp nests
// the real payload under wrappers (disappearing messages -> ephemeralMessage,
// view-once -> viewOnceMessage, edits -> editedMessage) and spreads text across
// many subtypes - missing these made real shop chats look "empty", which was the
// "no readable conversation found" bug. Media-only messages return a short
// placeholder so a photo-heavy price chat still counts as a real conversation.
function waMessageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  // Unwrap the common envelopes first (they hold a nested `message`).
  const inner =
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message.editedMessage?.message?.protocolMessage?.editedMessage ??
    message.documentWithCaptionMessage?.message ??
    null;
  if (inner) return waMessageText(inner);

  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    message.reactionMessage?.text ??
    "";
  if (String(text).trim()) return String(text);

  // Media with no caption is still a real turn (often a price-list photo).
  if (message.imageMessage) return "[photo]";
  if (message.videoMessage) return "[video]";
  if (message.audioMessage) return "[voice note]";
  if (message.documentMessage) return "[document]";
  if (message.stickerMessage) return "[sticker]";
  if (message.locationMessage) return "[location]";
  return "";
}

// Evolution's findMessages body shape varies across versions; try each so a
// real chat is never wrongly reported empty. EVERY returned record is then
// hard-filtered to the requested JID, so a version that ignores the server-side
// remoteJid filter (and returns the whole inbox) can NEVER leak another chat's
// messages into this thread. If a shape returns records but none match the
// requested chat, that response was unscoped - we discard it and try the next
// shape, never returning cross-chat rows.
async function findMessagesRecords(
  email: string,
  jid: string,
  limit: number
): Promise<any[]> {
  const instance = instanceNameFor(email);
  const bodies = [
    { where: { key: { remoteJid: jid } }, limit },
    { where: { remoteJid: jid }, limit },
    { remoteJid: jid, limit },
  ];
  for (const body of bodies) {
    try {
      const res = await evo(email, `/chat/findMessages/${instance}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const arr: any[] = Array.isArray(res.data)
        ? res.data
        : res.data?.messages?.records ?? res.data?.messages ?? res.data?.records ?? [];
      if (!arr.length) continue;
      // Keep ONLY records that belong to the requested chat.
      const scoped = arr.filter((m) => jidMatches(String(m?.key?.remoteJid ?? ""), jid));
      if (scoped.length) return scoped;
      // Records came back but none were this chat's - an unscoped response.
      // Do not return it; try the next shape (also filtered).
    } catch {
      /* try the next body shape */
    }
  }
  return [];
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
  const digits = digitsOnly(rawNumber);
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
    const hit = chats.find((c) => digitsOnly(c.jid).endsWith(tail));
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
  const arr = await findMessagesRecords(email, jid, limit);
  return arr
    .map((m) => ({
      fromMe: Boolean(m.key?.fromMe),
      text: waMessageText(m.message ?? {}),
      ts: Number(m.messageTimestamp ?? 0),
    }))
    .filter((m) => m.text.trim().length > 0)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Recent messages of one chat WITH their WhatsApp ids - the shape the
 * pull-sync needs to detect inbound replies whose webhook never arrived
 * (e.g. the Evolution host was down at delivery time).
 */
export interface WaMessageRaw {
  id: string;
  fromMe: boolean;
  text: string;
  ts: number; // seconds since epoch
  hasImage: boolean;
  remoteJid: string; // the message's TRUE origin chat - the per-message privacy anchor
  record: unknown; // full Evolution record (needed for media download)
}

export async function fetchMessagesRaw(
  email: string,
  jid: string,
  limit = 10
): Promise<WaMessageRaw[]> {
  const arr = await findMessagesRecords(email, jid, limit);
  return arr
    .map((m) => {
      const msg = m.message ?? {};
      // ROBUST fromMe: Evolution stores it in different spots depending on
      // version/endpoint. Missing the flag once misattributes the user's OWN
      // message as a shop reply (and the risk screen then "flags" it), so we
      // check every known location before defaulting to false.
      const fromMe = Boolean(
        m.key?.fromMe ?? (m as { fromMe?: boolean }).fromMe ?? m.message?.key?.fromMe
      );
      return {
        id: String(m.key?.id ?? ""),
        fromMe,
        text: waMessageText(msg),
        ts: Number(m.messageTimestamp ?? 0),
        hasImage: Boolean(msg.imageMessage ?? msg.ephemeralMessage?.message?.imageMessage),
        remoteJid: String(m.key?.remoteJid ?? ""),
        record: m,
      };
    })
    .filter((m) => m.id)
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
  const enc = encodeURIComponent(email.toLowerCase());
  await sbDelete("wa_sessions", `email=eq.${enc}`);
  // Purge the user's PARKED work too. Without this, an orphaned wa_outbox row
  // would (a) be drained by a background poll, whose ensureConnected re-created
  // the wa_sessions row we just deleted (silently undoing the disconnect), and
  // (b) fire stale sends the moment the user ever re-links. A torn-down link
  // must leave nothing behind that can message a shop.
  await sbDelete("wa_outbox", `sender_key=eq.${enc}`).catch(() => {});
  await sbDelete("graph_wakeups", `user_email=eq.${enc}`).catch(() => {});
  return ok;
}

/** Send a text from the user's own WhatsApp (rate-limited, human-like).
 *  `fast` skips the blocking presence-mimicry wait so the API returns quickly
 *  (used for interactive sends where the UI needs to feel instant; a short
 *  typing indicator still fires, and the guard already spaced the message). */
/**
 * A real Evolution /message/sendText success ALWAYS returns a message receipt:
 * `key.id` (the WhatsApp message id) and/or a `messageTimestamp`. HTTP 200 with
 * neither means the request was accepted by the HTTP layer but Baileys did not
 * actually create/dispatch a message - the ghost-send case. An explicit
 * status:"ERROR" is a hard reject. This is the single source of truth for
 * "did the message really leave".
 */
function hasSendReceipt(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as {
    key?: { id?: unknown };
    messageTimestamp?: unknown;
    messageId?: unknown;
    status?: unknown;
  };
  const status = String(d.status ?? "").toLowerCase();
  if (status === "error" || status === "failed") return false;
  return Boolean(d.key?.id || d.messageTimestamp || d.messageId);
}

export async function sendFromUser(
  email: string,
  to: string,
  message: string,
  fast = false
): Promise<{ ok: boolean; error?: string; rateLimited?: boolean; messageId?: string; unconfirmed?: boolean }> {
  const rate = await checkRateLimit(email);
  if (!rate.allowed) return { ok: false, rateLimited: true, error: rate.reason };

  const instance = instanceNameFor(email);
  const number = digitsOnly(to);

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
    // v2 shape first, then the legacy v1 body. IMPORTANT: only fall back to the
    // v1 shape on a DEFINITIVE status error (4xx/5xx = the server rejected the
    // shape, so nothing was delivered). A status 0 is an ABORT/TIMEOUT (our 12s
    // evoFetch deadline) - the request was in flight and MAY have delivered, so
    // re-POSTing it would risk a duplicate message (a velocity/uniformity ban
    // signal). Ambiguous timeouts propagate as {ok:false} and the drain's
    // transient re-queue handles recovery.
    let r = await evo(email, `/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number, text: message, delay: typingDelayForLength(message.length) }),
    });
    if (!r.ok && r.status !== 0) {
      r = await evo(email, `/message/sendText/${instance}`, {
        method: "POST",
        body: JSON.stringify({
          number,
          options: { delay: typingDelayForLength(message.length), presence: "composing" },
          textMessage: { text: message },
        }),
      });
    }
    return r;
  };

  // One reconnect-and-retry, but ONLY on a definitive HTTP status error (e.g.
  // "instance not connected" 4xx) where the send provably did not deliver. A
  // status 0 (abort/timeout) is ambiguous - never blindly re-POST it. We do NOT
  // retry on a 2xx-without-receipt: that response MAY have delivered, so a
  // re-POST would create a duplicate WhatsApp message (a velocity/uniformity ban
  // signal) - and the receipt shape varies across Evolution builds.
  let res = await trySend();
  if (!res.ok && res.status !== 0) {
    await evo(email, `/instance/connect/${instance}`);
    await new Promise((r) => setTimeout(r, 1200));
    res = await trySend();
  }
  // A 2xx from Evolution means the send request was accepted. A real send also
  // carries a message receipt (key.id / messageTimestamp); an EXPLICIT
  // status:"error"/"failed" is a hard reject. Everything else 2xx is a delivery.
  //
  // CRITICAL: we must NOT treat a 2xx WITHOUT a receipt as a failure. Different
  // Evolution builds return different success shapes (some omit key.id on the
  // first ACK, some nest it), so requiring a receipt made EVERY send look like a
  // ghost -> the drain re-queued the row for 24h -> the queue never cleared
  // (the "stuck queue" / "app non-functional" regression). Instead: a 2xx with a
  // receipt is CONFIRMED; a 2xx without one is accepted as SENT-BUT-UNCONFIRMED
  // (the row clears, the batch proceeds) and flagged so the UI can show it as
  // unverified rather than lying. Only an explicit error status re-queues.
  if (res.ok) {
    const rawStatus = String(res.data?.status ?? "").toLowerCase();
    if (rawStatus === "error" || rawStatus === "failed") {
      // An explicit WhatsApp reject on an otherwise-2xx response is an
      // account-level signal - feed the stop-loss so a run of them halts sends.
      import("./wa-guard").then((m) => m.noteSendOutcome(email, "hard")).catch(() => {});
      return { ok: false, error: "WhatsApp rejected the message" };
    }
    recordSend(email);
    // A clean send clears the stop-loss streak (the account is responding).
    import("./wa-guard").then((m) => m.noteSendOutcome(email, "ok")).catch(() => {});
    const id = String(res.data?.key?.id ?? res.data?.messageId ?? "");
    return { ok: true, messageId: id || undefined, unconfirmed: !hasSendReceipt(res.data) };
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
    const { recordSendFailure, noteSendOutcome } = await import("./wa-guard");
    const blocked = /not.*whatsapp|invalid|exist|blocked|forbidden/i.test(String(errText));
    await recordSendFailure(email, number, blocked ? "block" : "fail");
    // STOP-LOSS classification (distinct from the per-recipient risk above):
    // "hard" = an ACCOUNT-level restriction signal ONLY - an auth/rate HTTP
    // status (401/403/429) or text that reads as a restriction/ban/rate limit.
    // DELIBERATELY NOT status 0: a status-0 result is evoFetch's own 12s
    // abort/timeout or a network blip (a cold/slow Evolution host - the target
    // infra), NOT a WhatsApp restriction. The send path treats status 0 as an
    // ambiguous transient (never re-POSTed), and the drain re-queues it; feeding
    // it to the breaker would let a slow host self-inflict a 12h halt on a
    // healthy number. A scattered dead number (invalid/not-on-WhatsApp) is also
    // a LIST-quality problem, so it stays "soft" and resets the streak - only a
    // genuine run of account-level failures halts the whole queue.
    const hard =
      res.status === 401 ||
      res.status === 403 ||
      res.status === 429 ||
      /forbidden|too many|rate.?limit|\bban\b|banned|restrict|not.?authoriz|spam/i.test(
        String(errText)
      );
    await noteSendOutcome(email, hard ? "hard" : "soft");
  } catch {
    /* best-effort */
  }
  return { ok: false, error: errText };
}
