import "server-only";
import { hotStateClient } from "./rival-cache";

// ROUTE-LEVEL RATE LIMITING FOR SESSIONLESS ENDPOINTS.
//
// checkDailyLimit (usage.ts) is the only limiter the app had, and it is keyed
// per USER per day - it cannot see an unauthenticated caller at all. So every
// route that does real work WITHOUT a session (password reset, feedback
// submission, the Google-reviews proxy) was structurally unlimited: an open
// LLM faucet, an unbounded storage write, a billed-quota drain, and a
// password-reset flood that could lock a known account out and spam its inbox.
//
// This is a small IP-keyed fixed-window limiter for exactly those routes. When
// REDIS_URL is set it is atomic and fleet-wide (the same hot-state client the
// daily caps reserve through); without Redis it degrades to a per-instance
// window - weaker across a 20-instance fleet, but still turns "unlimited" into
// "20x the window", which is the difference between a nuisance and an outage.
// A limiter that can only ever REFUSE more is safe to add: a false refusal
// costs one retry, and it never grants access it should not.

interface Window {
  reset: number; // epoch ms when the window rolls over
  n: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_ratelimit__: Map<string, Window> | undefined;
}

function store(): Map<string, Window> {
  return (globalThis.__wd_ratelimit__ ??= new Map());
}

/** Best-effort client IP from the proxy headers Cloud Run / CDNs set. */
export function clientIp(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") || h.get("cf-connecting-ip") || h.get("fly-client-ip") || "unknown";
}

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the window rolls over (only meaningful when !ok). */
  retryAfter: number;
}

/**
 * Count one hit against a fixed window. `max` hits are allowed per
 * `windowSec`; the (max+1)th in the same window is refused.
 *
 * `id` is the discriminator (usually clientIp(req), optionally combined with a
 * per-target key such as the email being reset, so one attacker cannot hide
 * behind a rotating IP while hammering a single victim).
 */
export async function rateLimit(
  bucket: string,
  id: string,
  max: number,
  windowSec: number
): Promise<RateVerdict> {
  const key = `rl:${bucket}:${id}`;

  // Fleet-wide path: INCR is atomic, so concurrent callers get distinct totals
  // and exactly one can be the one that crosses the line.
  try {
    const r = await hotStateClient();
    if (r) {
      const n = await r.incr(key);
      // Set the expiry only on the first hit so later traffic cannot push the
      // window forward and keep a caller throttled forever.
      if (n === 1) await r.expire(key, windowSec);
      // The window rolls over in at most `windowSec`; that is the honest upper
      // bound for the retry hint without a separate TTL round-trip.
      if (n > Math.max(1, max)) return { ok: false, retryAfter: windowSec };
      return { ok: true, retryAfter: 0 };
    }
  } catch {
    // A Redis hiccup degrades to the per-instance window, never to a refusal.
  }

  // Per-instance fallback.
  const now = Date.now();
  const s = store();
  const cur = s.get(key);
  if (!cur || cur.reset <= now) {
    s.set(key, { reset: now + windowSec * 1000, n: 1 });
    // Bounded sweep so the map cannot grow one entry per distinct IP forever.
    if (s.size > 10_000) {
      for (const [k, v] of s) if (v.reset <= now) s.delete(k);
    }
    return { ok: true, retryAfter: 0 };
  }
  cur.n += 1;
  if (cur.n > Math.max(1, max)) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Test seam - the per-instance window store is a module singleton. */
export function _resetRateLimit(): void {
  globalThis.__wd_ratelimit__ = new Map();
}
