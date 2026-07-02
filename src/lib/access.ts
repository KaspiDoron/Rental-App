// User registry / access control.
//
// Signups are stored in-memory per instance and mirrored to Supabase
// (app_users) when configured, so every registration is durably saved.

import { sbInsert } from "./runtime-config";

export interface UserRecord {
  email: string;
  phone?: string;
  name?: string;
  provider: "email" | "google";
  status: "active" | "blocked";
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

export function getUser(email: string): UserRecord | undefined {
  return store().get(email.toLowerCase());
}

export async function registerUser(u: {
  email: string;
  phone?: string;
  name?: string;
  provider: "email" | "google";
  acceptedTerms: boolean;
}): Promise<UserRecord> {
  const key = u.email.toLowerCase();
  const now = Date.now();
  const existing = store().get(key);
  const rec: UserRecord = existing
    ? {
        ...existing,
        phone: u.phone || existing.phone,
        name: u.name || existing.name,
        lastSeen: now,
      }
    : {
        email: key,
        phone: u.phone,
        name: u.name,
        provider: u.provider,
        status: "active",
        termsAcceptedAt: u.acceptedTerms ? now : undefined,
        addedAt: now,
        lastSeen: now,
      };
  store().set(key, rec);

  // Durable mirror (no-op without Supabase). Everything is saved.
  await sbInsert(
    "app_users",
    [
    {
      email: rec.email,
      phone: rec.phone ?? null,
      name: rec.name ?? null,
      provider: rec.provider,
      status: rec.status,
      terms_accepted_at: rec.termsAcceptedAt
        ? new Date(rec.termsAcceptedAt).toISOString()
        : null,
      last_seen: new Date(now).toISOString(),
    },
    ],
    "email"
  );
  return rec;
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
      addedAt: Date.now(),
      lastSeen: Date.now(),
    });
}
