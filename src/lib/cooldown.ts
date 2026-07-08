// Temporary per-user blocks (durable in Supabase, in-memory fallback).
//
// The main use is the free-tier pickup-bypass rule (task): free users may only
// arrange TODAY pickups. If a free user tries to arrange a next-day pickup
// (through a custom message, or by ditching the app and asking the shop
// directly on their own WhatsApp), we block them from sending through our
// system for a cooldown window, so they cannot bypass the paid feature.

import "server-only";
import { sbInsert, sbSelect, sbDelete } from "./runtime-config";

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
  mem().set(`${email}:${kind}`, until);
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

// Language that indicates arranging a pickup on a FUTURE day (not today).
const FUTURE_PICKUP =
  /\b(tomorrow|next day|day after|the following day|in \d+ days?|next week|on (mon|tues|wednes|thurs|fri|satur|sun)day|pick ?up (on|next|tomorrow)|deliver (tomorrow|next)|book for (tomorrow|the \d))\b/i;

/** True if the text tries to arrange a pickup/delivery on a day other than today. */
export function requestsFuturePickup(text: string): boolean {
  return FUTURE_PICKUP.test(text);
}
