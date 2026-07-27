// Temporary per-user blocks (durable in Supabase, in-memory fallback).
//
// The main use is the free-tier pickup-bypass rule (task): free users may only
// arrange TODAY pickups. If a free user tries to arrange a next-day pickup
// (through a custom message, or by ditching the app and asking the shop
// directly on their own WhatsApp), we block them from sending through our
// system for a cooldown window, so they cannot bypass the paid feature.

import "server-only";
import { sbInsert, sbSelect, sbDelete } from "./runtime-config";
import { boundedSet } from "./bounded-map";

declare global {
  // eslint-disable-next-line no-var
  var __wd_cooldowns__: Map<string, number> | undefined;
}
function mem(): Map<string, number> {
  if (!globalThis.__wd_cooldowns__) globalThis.__wd_cooldowns__ = new Map();
  return globalThis.__wd_cooldowns__;
}

export async function setCooldown(
  email: string,
  kind: string,
  minutes: number,
  reason?: string
): Promise<void> {
  const until = Date.now() + minutes * 60_000;
  boundedSet(mem(), `${email}:${kind}`, until, 5000);
  try {
    await sbInsert(
      "user_cooldowns",
      [{ email: email.toLowerCase(), kind, until: new Date(until).toISOString(), reason: reason ?? null }],
      "email,kind"
    );
  } catch {
    /* in-memory still enforces it */
  }
}

/** Remaining cooldown in minutes (0 if none). */
export async function cooldownLeft(email: string, kind: string): Promise<number> {
  const key = `${email}:${kind}`;
  const local = mem().get(key);
  let until = local ?? 0;
  try {
    const rows = await sbSelect<{ until: string }>(
      "user_cooldowns",
      `select=until&email=eq.${encodeURIComponent(email.toLowerCase())}&kind=eq.${encodeURIComponent(
        kind
      )}&limit=1`
    );
    if (rows[0]) until = Math.max(until, Date.parse(rows[0].until));
  } catch {
    /* fall back to memory */
  }
  if (!until || until <= Date.now()) {
    if (local && local <= Date.now()) {
      mem().delete(key);
      sbDelete("user_cooldowns", `email=eq.${encodeURIComponent(email.toLowerCase())}&kind=eq.${encodeURIComponent(kind)}`).catch(() => {});
    }
    return 0;
  }
  return Math.ceil((until - Date.now()) / 60_000);
}

/**
 * End a cooldown NOW, before its own expiry.
 *
 * Every restriction the integrity ladder can impose has to be reversible by the
 * owner in one click, so this is the other half of `setCooldown` rather than a
 * detail of the Ops panel.
 */
export async function clearCooldown(email: string, kind: string): Promise<void> {
  const key = `${email.toLowerCase()}:${kind}`;
  mem().delete(key);
  mem().delete(`${email}:${kind}`);
  await sbDelete(
    "user_cooldowns",
    `email=eq.${encodeURIComponent(email.toLowerCase())}&kind=eq.${encodeURIComponent(kind)}`
  ).catch(() => {});
}

// The one-strike `requestsFuturePickup` regex that used to live here is gone.
// It was the whole enforcement of the free-tier rule - one phrase, one six-hour
// block - and it is now `future-pickup`, ONE weighted signal among several in
// lib/integrity/signals, where a single phrase can never decide anything.

// ---- Brute-force throttle (login + verify-code) ------------------------------
// Per-key failed-attempt counter with a rolling window. Backed by the same
// in-memory map (per instance); combined with a durable cooldown row once the
// threshold trips, so a lockout survives an instance rotation.
declare global {
  // eslint-disable-next-line no-var
  var __wd_attempts__: Map<string, { n: number; first: number }> | undefined;
}
function attempts(): Map<string, { n: number; first: number }> {
  if (!globalThis.__wd_attempts__) globalThis.__wd_attempts__ = new Map();
  return globalThis.__wd_attempts__;
}

/**
 * Record one failed attempt for (email, kind). After `max` failures within
 * `windowMin`, sets a durable cooldown of `lockMin` and returns locked. Reads
 * the durable cooldown too, so an existing lockout is honored immediately.
 */
export async function noteAuthFailure(
  email: string,
  kind: string,
  max = 6,
  windowMin = 15,
  lockMin = 15
): Promise<{ locked: boolean; lockedMinutes: number }> {
  const existing = await cooldownLeft(email, `lock:${kind}`);
  if (existing > 0) return { locked: true, lockedMinutes: existing };
  const key = `${email}:${kind}`;
  const now = Date.now();
  const rec = attempts().get(key);
  if (!rec || now - rec.first > windowMin * 60_000) {
    boundedSet(attempts(), key, { n: 1, first: now }, 5000);
    return { locked: false, lockedMinutes: 0 };
  }
  rec.n += 1;
  if (rec.n >= max) {
    attempts().delete(key);
    await setCooldown(email, `lock:${kind}`, lockMin, `too many failed ${kind} attempts`);
    return { locked: true, lockedMinutes: lockMin };
  }
  return { locked: false, lockedMinutes: 0 };
}

/** Minutes remaining on an auth lockout (0 if none). */
export async function authLockLeft(email: string, kind: string): Promise<number> {
  return cooldownLeft(email, `lock:${kind}`);
}

/** Clear the failed-attempt state on a successful auth. */
export function clearAuthFailures(email: string, kind: string): void {
  attempts().delete(`${email}:${kind}`);
}
