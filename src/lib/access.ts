// User registry / access control, with password auth and plans.
//
// Supabase (app_users) is the DURABLE source of truth: signups, password
// changes and plan upgrades are written there and read back on every lookup,
// so accounts work across serverless instances and deploys. A short in-memory
// cache keeps latency low, and everything still works (non-durably) with no
// Supabase configured.
//
// Plan naming: the top tier is "ultra" in the product. It is stored as
// "business" in the app_users.plan column (legacy check constraint) and
// normalised on read, so old databases keep working without a migration.

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { sbInsert, sbSelect, sbDelete, supabaseConfigured } from "./runtime-config";

export type PlanId = "free" | "pro" | "ultra";

/** Normalise any stored plan value ("business" was renamed to Ultra). */
export function normalizePlan(p: string | undefined | null): PlanId {
  if (p === "pro") return "pro";
  if (p === "ultra" || p === "business") return "ultra";
  return "free";
}

/** Value written to the app_users.plan column (kept legacy-compatible). */
function dbPlan(p: PlanId): string {
  return p === "ultra" ? "business" : p;
}

export interface UserRecord {
  email: string;
  phone?: string;
  name?: string;
  provider: "email" | "google" | "dev";
  status: "active" | "blocked";
  plan: PlanId;
  passwordHash?: string;
  mustChangePassword?: boolean;
  termsAcceptedAt?: number;
  // The two additional mandatory consents (WhatsApp ban risk + AI responsibility).
  waRiskAcceptedAt?: number;
  aiResponsibilityAcceptedAt?: number;
  addedAt: number;
  lastSeen: number;
}

interface CacheEntry {
  rec: UserRecord;
  fetchedAt: number;
}

const CACHE_TTL_MS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_users_v2__: Map<string, CacheEntry> | undefined;
}

function cache() {
  if (!globalThis.__wheeldeal_users_v2__) {
    globalThis.__wheeldeal_users_v2__ = new Map();
  }
  return globalThis.__wheeldeal_users_v2__;
}

function remember(rec: UserRecord) {
  cache().set(rec.email, { rec, fetchedAt: Date.now() });
}

// ---- password hashing --------------------------------------------------------

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 32).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored?: string): boolean {
  if (!stored) return false;
  const [v, salt, hash] = stored.split(":");
  if (v !== "s1" || !salt || !hash) return false;
  const candidate = scryptSync(plain, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

// ---- Supabase row mapping -----------------------------------------------------

interface UserRow {
  email: string;
  phone: string | null;
  name: string | null;
  provider: string | null;
  status: string | null;
  plan: string | null;
  password_hash: string | null;
  must_change_password: boolean | null;
  terms_accepted_at: string | null;
  wa_risk_accepted_at: string | null;
  ai_responsibility_accepted_at: string | null;
  added_at: string | null;
  last_seen: string | null;
}

function fromRow(r: UserRow): UserRecord {
  return {
    email: r.email,
    phone: r.phone ?? undefined,
    name: r.name ?? undefined,
    provider: (["email", "google", "dev"].includes(r.provider ?? "")
      ? r.provider
      : "email") as UserRecord["provider"],
    status: r.status === "blocked" ? "blocked" : "active",
    plan: normalizePlan(r.plan),
    passwordHash: r.password_hash ?? undefined,
    mustChangePassword: Boolean(r.must_change_password),
    termsAcceptedAt: r.terms_accepted_at ? Date.parse(r.terms_accepted_at) : undefined,
    waRiskAcceptedAt: r.wa_risk_accepted_at ? Date.parse(r.wa_risk_accepted_at) : undefined,
    aiResponsibilityAcceptedAt: r.ai_responsibility_accepted_at
      ? Date.parse(r.ai_responsibility_accepted_at)
      : undefined,
    addedAt: r.added_at ? Date.parse(r.added_at) : Date.now(),
    lastSeen: r.last_seen ? Date.parse(r.last_seen) : Date.now(),
  };
}

/** Write a record to Supabase. Returns false when the durable write failed. */
async function mirror(rec: UserRecord): Promise<boolean> {
  remember(rec);
  const base = {
    email: rec.email,
    phone: rec.phone ?? null,
    name: rec.name ?? null,
    provider: rec.provider,
    status: rec.status,
    plan: dbPlan(rec.plan),
    password_hash: rec.passwordHash ?? null,
    must_change_password: rec.mustChangePassword ?? false,
    terms_accepted_at: rec.termsAcceptedAt ? new Date(rec.termsAcceptedAt).toISOString() : null,
    last_seen: new Date(rec.lastSeen).toISOString(),
  };
  const withConsents = {
    ...base,
    wa_risk_accepted_at: rec.waRiskAcceptedAt ? new Date(rec.waRiskAcceptedAt).toISOString() : null,
    ai_responsibility_accepted_at: rec.aiResponsibilityAcceptedAt
      ? new Date(rec.aiResponsibilityAcceptedAt).toISOString()
      : null,
  };
  // sbInsert fails silently on an unknown column, so before the consent-column
  // migration runs the whole upsert (and thus signup) would break. Retry
  // without the new columns so registration never depends on a pending
  // migration - same graceful-degradation pattern used across the app.
  const ok = await sbInsert("app_users", [withConsents], "email");
  if (ok) return true;
  return sbInsert("app_users", [base], "email");
}

// ---- CRUD ---------------------------------------------------------------------

/**
 * Look a user up. Reads through to Supabase (the durable store) with a short
 * per-instance cache; pass { fresh: true } for auth-critical checks.
 */
export async function getUser(
  email: string,
  opts?: { fresh?: boolean }
): Promise<UserRecord | undefined> {
  const key = email.trim().toLowerCase();
  const hit = cache().get(key);
  if (hit && !opts?.fresh && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.rec;
  }
  if (supabaseConfigured()) {
    const rows = await sbSelect<UserRow>(
      "app_users",
      `select=*&email=eq.${encodeURIComponent(key)}&limit=1`
    );
    if (rows.length) {
      const rec = fromRow(rows[0]);
      remember(rec);
      return rec;
    }
  }
  // No durable row (or no Supabase): fall back to what this instance knows.
  return hit?.rec;
}

export async function registerUser(u: {
  email: string;
  phone?: string;
  name?: string;
  password?: string;
  provider: "email" | "google" | "dev";
  acceptedTerms: boolean;
  acceptedWaRisk?: boolean;
  acceptedAiResp?: boolean;
  plan?: PlanId;
}): Promise<UserRecord> {
  const key = u.email.trim().toLowerCase();
  const now = Date.now();
  const existing = await getUser(key, { fresh: true });
  const rec: UserRecord = existing
    ? {
        ...existing,
        phone: u.phone || existing.phone,
        name: u.name || existing.name,
        passwordHash: u.password ? hashPassword(u.password) : existing.passwordHash,
        plan: u.plan ?? existing.plan,
        lastSeen: now,
      }
    : {
        email: key,
        phone: u.phone,
        name: u.name,
        provider: u.provider,
        status: "active",
        plan: u.plan ?? "free",
        passwordHash: u.password ? hashPassword(u.password) : undefined,
        termsAcceptedAt: u.acceptedTerms ? now : undefined,
        waRiskAcceptedAt: u.acceptedWaRisk ? now : undefined,
        aiResponsibilityAcceptedAt: u.acceptedAiResp ? now : undefined,
        addedAt: now,
        lastSeen: now,
      };
  // The durable write is what makes the account (and its phone) survive
  // sign-out, new serverless instances and cache expiry. Never trust the
  // 10s memory cache alone: retry once, then leave a visible trail.
  let persisted = await mirror(rec);
  if (!persisted && supabaseConfigured()) {
    persisted = await mirror(rec);
    if (!persisted) {
      await sbInsert("agent_events", [
        {
          kind: "user-persist-failed",
          vendor_id: "",
          vendor_name: key,
          detail: "app_users upsert failed twice - phone/profile may not survive this instance",
        },
      ]).catch(() => {});
    }
  }
  return rec;
}

/**
 * Set a new password. Returns false when the user does not exist OR when the
 * durable write failed (so callers can tell the user instead of lying).
 */
export async function setPassword(
  email: string,
  password: string,
  mustChange = false
): Promise<boolean> {
  const rec = await getUser(email, { fresh: true });
  if (!rec) return false;
  rec.passwordHash = hashPassword(password);
  rec.mustChangePassword = mustChange;
  const persisted = await mirror(rec);
  return supabaseConfigured() ? persisted : true;
}

/**
 * Permanently erase a user (not a block): removes their account row from the
 * durable store and the in-memory cache. The caller also severs the user's
 * WhatsApp link so nothing about them remains.
 */
export async function deleteUser(email: string): Promise<boolean> {
  const key = email.toLowerCase();
  cache().delete(key);
  cache().delete(email);
  return sbDelete("app_users", `email=eq.${encodeURIComponent(key)}`);
}

export async function setPlan(email: string, plan: PlanId): Promise<void> {
  const rec = await getUser(email, { fresh: true });
  if (!rec) return;
  rec.plan = plan;
  await mirror(rec);
}

export async function touchUser(email: string): Promise<void> {
  const rec = await getUser(email);
  if (!rec) return;
  rec.lastSeen = Date.now();
  await mirror(rec);
}

export async function isBlocked(email: string): Promise<boolean> {
  return (await getUser(email))?.status === "blocked";
}

/** Every registered user, durable store first, newest activity first. */
export async function listUsers(): Promise<UserRecord[]> {
  const seen = new Map<string, UserRecord>();
  if (supabaseConfigured()) {
    const rows = await sbSelect<UserRow>(
      "app_users",
      "select=*&order=last_seen.desc&limit=500"
    );
    for (const r of rows) {
      const rec = fromRow(r);
      seen.set(rec.email, rec);
      remember(rec);
    }
  }
  // Include anything this instance knows that has not landed durably yet.
  for (const { rec } of cache().values()) {
    if (!seen.has(rec.email)) seen.set(rec.email, rec);
  }
  return [...seen.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export async function setUserStatus(
  email: string,
  status: "active" | "blocked"
): Promise<void> {
  const key = email.trim().toLowerCase();
  const rec = (await getUser(key, { fresh: true })) ?? {
    email: key,
    provider: "email" as const,
    status,
    plan: "free" as PlanId,
    addedAt: Date.now(),
    lastSeen: Date.now(),
  };
  rec.status = status;
  await mirror(rec);
}
