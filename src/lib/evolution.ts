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

// ---- Evolution API client -------------------------------------------------------

async function evoConfig(): Promise<{ url: string; key: string } | null> {
  const [url, key] = await Promise.all([
    getConfig("EVOLUTION_API_URL"),
    getConfig("EVOLUTION_API_KEY"),
  ]);
  if (!url || !key) return null;
  return { url: url.trim().replace(/\/$/, ""), key: key.trim() };
}

export async function evolutionConfigured(): Promise<boolean> {
  return (await evoConfig()) !== null;
}

/** Deterministic, collision-safe instance name for a user. */
export function instanceNameFor(email: string): string {
  return `wd-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** Token Evolution must echo back to our webhook (derived, never stored raw). */
export async function webhookToken(): Promise<string | null> {
  const cfg = await evoConfig();
  if (!cfg) return null;
  return createHash("sha256").update(`wd-webhook:${cfg.key}`).digest("hex").slice(0, 32);
}

async function evoFetch(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  const cfg = await evoConfig();
  if (!cfg) return { ok: false, status: 0, data: { error: "not configured" } };
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
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

/** Look up which user owns an instance (used by the webhook). */
export async function emailForInstance(instance: string): Promise<string | null> {
  const rows = await sbSelect<{ email: string }>(
    "wa_sessions",
    `select=email&instance_name=eq.${encodeURIComponent(instance)}&limit=1`
  );
  return rows[0]?.email ?? null;
}

async function saveSession(email: string, instance: string, status: string) {
  await sbInsert(
    "wa_sessions",
    [
      {
        email,
        instance_name: instance,
        status,
        updated_at: new Date().toISOString(),
      },
    ],
    "email"
  );
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
  const token = await webhookToken();
  const webhookUrl = `${appOrigin}/api/webhooks/evolution?token=${token}`;

  // Try to create; a 403/409 "already in use" simply means it exists.
  const created = await evoFetch("/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: instance,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      webhook: { url: webhookUrl, byEvents: false, events: ["MESSAGES_UPSERT"] },
    }),
  });
  if (!created.ok && created.status !== 403 && created.status !== 409) {
    // Older Evolution builds use a flat webhook field - retry once.
    const legacy = await evoFetch("/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        webhook: webhookUrl,
        events: ["MESSAGES_UPSERT"],
      }),
    });
    if (!legacy.ok && legacy.status !== 403 && legacy.status !== 409) {
      return {
        ok: false,
        error:
          legacy.data?.response?.message?.toString?.() ??
          legacy.data?.message ??
          legacy.data?.error ??
          `Evolution API ${legacy.status}`,
      };
    }
  }

  // Make sure the webhook is set even for pre-existing instances.
  await evoFetch(`/webhook/set/${instance}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: { enabled: true, url: webhookUrl, byEvents: false, events: ["MESSAGES_UPSERT"] },
      // legacy shape (ignored by v2):
      enabled: true,
      url: webhookUrl,
      events: ["MESSAGES_UPSERT"],
    }),
  });

  // Ask for the QR AND (when we know the user's phone) an 8-character pairing
  // code - the code is what makes linking possible on the SAME phone that has
  // WhatsApp: Linked Devices -> "Link with phone number instead".
  const digits = (phone ?? "").replace(/[^\d]/g, "");
  const conn = await evoFetch(
    `/instance/connect/${instance}${digits ? `?number=${digits}` : ""}`
  );
  const state = await connectionState(email);
  await saveSession(email, instance, state ?? "connecting");

  const qr =
    conn.data?.base64 ??
    conn.data?.qrcode?.base64 ??
    (typeof conn.data?.code === "string" && conn.data.code.startsWith("data:")
      ? conn.data.code
      : undefined);

  const rawPairing = conn.data?.pairingCode;
  return {
    ok: true,
    state: state ?? "connecting",
    qr,
    pairingCode:
      typeof rawPairing === "string" && /^[A-Z0-9-]{8,9}$/i.test(rawPairing)
        ? rawPairing
        : undefined,
  };
}

/** True when this number is actually on WhatsApp (checked via the session). */
export async function numberOnWhatsApp(
  email: string,
  number: string
): Promise<boolean | null> {
  const instance = instanceNameFor(email);
  const res = await evoFetch(`/chat/whatsappNumbers/${instance}`, {
    method: "POST",
    body: JSON.stringify({ numbers: [number.replace(/[^\d]/g, "")] }),
  });
  if (!res.ok || !Array.isArray(res.data)) return null; // unknown - don't block
  return Boolean(res.data[0]?.exists ?? res.data[0]?.numberExists);
}

/** "open" = paired and ready to send. */
export async function connectionState(email: string): Promise<string | null> {
  const instance = instanceNameFor(email);
  const res = await evoFetch(`/instance/connectionState/${instance}`);
  if (!res.ok) return null;
  return res.data?.instance?.state ?? res.data?.state ?? null;
}

export async function disconnectInstance(email: string): Promise<boolean> {
  const instance = instanceNameFor(email);
  await evoFetch(`/instance/logout/${instance}`, { method: "DELETE" });
  const res = await evoFetch(`/instance/delete/${instance}`, { method: "DELETE" });
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

  // Never message a number that is not on WhatsApp (some shops list landlines).
  const exists = await numberOnWhatsApp(email, number);
  if (exists === false) {
    return { ok: false, error: "not-on-whatsapp" };
  }

  // v2 shape first, then the legacy v1 body.
  let res = await evoFetch(`/message/sendText/${instance}`, {
    method: "POST",
    body: JSON.stringify({ number, text: message, delay: TYPING_DELAY_MS() }),
  });
  if (!res.ok) {
    res = await evoFetch(`/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({
        number,
        options: { delay: TYPING_DELAY_MS(), presence: "composing" },
        textMessage: { text: message },
      }),
    });
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
