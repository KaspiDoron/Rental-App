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
import { getConfig, sbInsert, sbSelect } from "./runtime-config";

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
  var __wd_wa_health__: Map<string, { ok: boolean; exp: number }> | undefined;
}
function healthStore() {
  if (!globalThis.__wd_wa_health__) globalThis.__wd_wa_health__ = new Map();
  return globalThis.__wd_wa_health__;
}

async function hostHealthy(h: Host): Promise<boolean> {
  const cache = healthStore();
  const hit = cache.get(h.url);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(`${h.url}/instance/fetchInstances`, {
      headers: { apikey: h.key },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    ok = res.status < 500; // reachable and not erroring (401 still = alive)
  } catch {
    ok = false;
  }
  cache.set(h.url, { ok, exp: Date.now() + 15_000 });
  return ok;
}

function hostPref(email: string, url: string): number {
  return parseInt(
    createHash("sha256").update(`${email.toLowerCase()}:${url}`).digest("hex").slice(0, 8),
    16
  );
}

/** The Evolution host this user's session should live on right now. */
async function resolveHost(email: string): Promise<Host | null> {
  const hosts = await getHosts();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return hosts[0];

  // Stick to the stored host while it is healthy (keeps the session in place).
  const rows = await sbSelect<{ host_url: string | null }>(
    "wa_sessions",
    `select=host_url&email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  const stored = rows[0]?.host_url;
  if (stored) {
    const h = hosts.find((x) => x.url === stored);
    if (h && (await hostHealthy(h))) return h;
  }

  // Otherwise pick a healthy host, preferring a stable per-user assignment.
  const order = [...hosts].sort((a, b) => hostPref(email, a.url) - hostPref(email, b.url));
  for (const h of order) {
    if (await hostHealthy(h)) return h;
  }
  return order[0] ?? null; // everything down - return the preferred anyway
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

  // Pairing code needs the number PASSED AT CREATE time in Evolution v2 - the
  // create response then carries the pairing code directly.
  const createBody: Record<string, unknown> = {
    instanceName: instance,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
    webhook: { url: webhookUrl, byEvents: false, events: ["MESSAGES_UPSERT"] },
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
      webhook: { enabled: true, url: webhookUrl, byEvents: false, events: ["MESSAGES_UPSERT"] },
      enabled: true,
      url: webhookUrl,
      events: ["MESSAGES_UPSERT"],
    }),
  });

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

/** "open" = paired and ready to send. */
export async function connectionState(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evo(email, `/instance/connectionState/${instance}`);
  if (!res.ok) return null;
  const state = res.data?.instance?.state ?? res.data?.state ?? null;
  if (state === "open") markOpen(email).catch(() => {});
  return state;
}

export async function disconnectInstance(email: string): Promise<boolean> {
  const instance = instanceNameFor(email);
  await evo(email, `/instance/logout/${instance}`, { method: "DELETE" });
  const res = await evo(email, `/instance/delete/${instance}`, { method: "DELETE" });
  await saveSession(email, instance, "disconnected");
  return res.ok;
}

/** Send a text from the user's own WhatsApp (rate-limited, human-like). */
export async function sendFromUser(
  email: string,
  to: string,
  message: string
): Promise<{ ok: boolean; error?: string; rateLimited?: boolean }> {
  const rate = await checkRateLimit(email);
  if (!rate.allowed) return { ok: false, rateLimited: true, error: rate.reason };

  const instance = instanceNameFor(email);
  const number = to.replace(/[^\d]/g, "");

  // Resume the session if it dropped, instead of failing outright.
  const conn = await ensureConnected(email, 6000);
  if (!conn.ok) {
    const paired = await wasEverConnected(email);
    return {
      ok: false,
      error: paired ? "reconnecting" : "not-connected",
    };
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
  return {
    ok: false,
    error:
      res.data?.response?.message?.toString?.() ??
      res.data?.message ??
      res.data?.error ??
      `Evolution API ${res.status}`,
  };
}
