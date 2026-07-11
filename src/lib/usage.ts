// API cost guard - tracking, caching and abuse limits for every paid/quota'd
// external call (Google Maps, AI tokens, WhatsApp sends).
//
// Goals: never waste a request (caching), track every call durably
// (api_usage), enforce per-user daily limits (configurable by the owner in
// Admin -> Limits), and a global KILL SWITCH that halts all paid services.

import "server-only";
import { getConfig, sbInsert, sbSelect } from "./runtime-config";

// Free monthly quotas we track against (shown in the cost tracker).
export const QUOTAS: Record<string, { free: number; label: string; unitCost: number }> = {
  places_search: { free: 5000, label: "Google Places searches", unitCost: 0.032 },
  place_details: { free: 5000, label: "Google Place details", unitCost: 0.017 },
  geocoding: { free: 10000, label: "Google Geocoding", unitCost: 0.005 },
  photo: { free: 5000, label: "Google photos", unitCost: 0.007 },
};

// ---- kill switch ---------------------------------------------------------------

export async function killSwitchOn(): Promise<boolean> {
  return (await getConfig("KILL_SWITCH")) === "1";
}

// ---- durable usage log -----------------------------------------------------------

export async function recordApi(kind: string, count = 1, userEmail?: string) {
  await sbInsert("api_usage", [
    { kind, count, user_email: userEmail ?? null },
  ]).catch(() => {});
}

/** Usage this calendar month per kind (for the cost tracker). */
export async function monthlyUsage(): Promise<Record<string, number>> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await sbSelect<{ kind: string; count: number }>(
    "api_usage",
    `select=kind,count&created_at=gte.${encodeURIComponent(start.toISOString())}&limit=10000`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + (r.count ?? 1);
  return out;
}

// ---- per-user daily limits (owner-configurable) -----------------------------------

const LIMIT_DEFAULTS: Record<string, number> = {
  LIMIT_SEARCHES_PER_DAY: 15, // vendor discovery (Places searches)
  LIMIT_GEOCODE_PER_DAY: 40, // address lookups
  LIMIT_AI_PER_DAY: 120, // AI calls (extraction, drafts, translate sweeps)
  LIMIT_TRANSLATE_PER_DAY: 60, // UI translate sweeps (cache means most are free)
  LIMIT_WA_PER_HOUR: 15, // personal WhatsApp sends
  LIMIT_WA_PER_DAY: 60,
};

export async function limitFor(name: keyof typeof LIMIT_DEFAULTS): Promise<number> {
  const v = Number(await getConfig(name));
  return Number.isFinite(v) && v > 0 ? v : LIMIT_DEFAULTS[name];
}

export function limitDefaults() {
  return { ...LIMIT_DEFAULTS };
}

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_limits__: Map<string, { day: string; n: number }> | undefined;
}

function counters() {
  if (!globalThis.__wheeldeal_limits__) globalThis.__wheeldeal_limits__ = new Map();
  return globalThis.__wheeldeal_limits__;
}

/**
 * Count one use against a per-user daily limit. Uses the durable api_usage log
 * (accurate across serverless instances) with an in-memory fast path.
 */
export async function checkDailyLimit(
  kind: string,
  who: string,
  limitName: keyof typeof LIMIT_DEFAULTS
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const limit = await limitFor(limitName);
  const today = new Date().toISOString().slice(0, 10);
  const key = `${kind}:${who}`;
  const mem = counters().get(key);
  if (mem?.day === today && mem.n >= limit) {
    return { allowed: false, used: mem.n, limit };
  }
  const rows = await sbSelect<{ count: number }>(
    "api_usage",
    `select=count&kind=eq.${encodeURIComponent(kind)}&user_email=eq.${encodeURIComponent(
      who
    )}&created_at=gte.${encodeURIComponent(today)}&limit=1000`
  );
  const used = rows.reduce((s, r) => s + (r.count ?? 1), 0);
  counters().set(key, { day: today, n: Math.max(used, mem?.day === today ? mem.n : 0) });
  if (used >= limit) return { allowed: false, used, limit };
  const cur = counters().get(key)!;
  cur.n += 1;
  return { allowed: true, used: used + 1, limit };
}

// ---- request caching (saves real money) --------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_apicache__: Map<string, { exp: number; data: unknown }> | undefined;
}

function apiCache() {
  if (!globalThis.__wheeldeal_apicache__) globalThis.__wheeldeal_apicache__ = new Map();
  return globalThis.__wheeldeal_apicache__;
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = apiCache().get(key);
  if (hit && hit.exp > Date.now()) return hit.data as T;
  return undefined;
}

export function cacheSet(key: string, data: unknown, ttlMs: number) {
  const c = apiCache();
  if (c.size > 500) c.clear();
  c.set(key, { exp: Date.now() + ttlMs, data });
}
