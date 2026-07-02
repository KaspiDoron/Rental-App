// User registry / access control, with password auth and plans.
//
// Passwords are stored as scrypt hashes (salted). Signups are stored in-memory
// per instance and mirrored to Supabase (app_users) so every registration is
// durably saved.

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { sbInsert } from "./runtime-config";

export type PlanId = "free" | "pro" | "business";

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
  addedAt: number;
  lastSeen: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_users__: Map<string, UserRecord> | undefined;
}

function store() {
  if (!globalThis.__wheeldeal_users__) {
    globalThis.__wheeldeal_users__ = new Map();
  }
  return globalThis.__wheeldeal_users__;
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

// ---- persistence mirror --------------------------------------------------------

async function mirror(rec: UserRecord) {
  await sbInsert(
    "app_users",
    [
      {
        email: rec.email,
        phone: rec.phone ?? null,
        name: rec.name ?? null,
        provider: rec.provider,
        status: rec.status,
        plan: rec.plan,
        password_hash: rec.passwordHash ?? null,
        must_change_password: rec.mustChangePassword ?? false,
        terms_accepted_at: rec.termsAcceptedAt
          ? new Date(rec.termsAcceptedAt).toISOString()
          : null,
        last_seen: new Date(rec.lastSeen).toISOString(),
      },
    ],
    "email"
  );
}

// ---- CRUD ---------------------------------------------------------------------

export function getUser(email: string): UserRecord | undefined {
  return store().get(email.toLowerCase());
}

export async function registerUser(u: {
  email: string;
  phone?: string;
  name?: string;
  password?: string;
  provider: "email" | "google" | "dev";
  acceptedTerms: boolean;
  plan?: PlanId;
}): Promise<UserRecord> {
  const key = u.email.toLowerCase();
  const now = Date.now();
  const existing = store().get(key);
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
        addedAt: now,
        lastSeen: now,
      };
  store().set(key, rec);
  await mirror(rec);
  return rec;
}

export async function setPassword(
  email: string,
  password: string,
  mustChange = false
): Promise<boolean> {
  const rec = store().get(email.toLowerCase());
  if (!rec) return false;
  rec.passwordHash = hashPassword(password);
  rec.mustChangePassword = mustChange;
  await mirror(rec);
  return true;
}

export async function setPlan(email: string, plan: PlanId): Promise<void> {
  const rec = store().get(email.toLowerCase());
  if (!rec) return;
  rec.plan = plan;
  await mirror(rec);
}

export function touchUser(email: string) {
  const rec = store().get(email.toLowerCase());
  if (rec) rec.lastSeen = Date.now();
}

export function isBlocked(email: string): boolean {
  return store().get(email.toLowerCase())?.status === "blocked";
}

export function listUsers(): UserRecord[] {
  return [...store().values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function setUserStatus(email: string, status: "active" | "blocked") {
  const key = email.toLowerCase();
  const rec = store().get(key);
  if (rec) rec.status = status;
  else
    store().set(key, {
      email: key,
      provider: "email",
      status,
      plan: "free",
      addedAt: Date.now(),
      lastSeen: Date.now(),
    });
}
