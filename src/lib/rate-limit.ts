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

/**
 * The one bucket every caller we cannot identify shares.
 *
 * FAIL CLOSED, NOT OPEN. The old code answered "unknown" for a caller with no
 * usable header, which reads the same but was reached from the WRONG side: it
 * was the fallback after trusting attacker-written values. Now it is the answer
 * whenever the platform's own value is absent or unparseable, and everyone who
 * lands here shares a single window - a limiter that over-refuses costs one
 * retry; one that under-refuses is the bug this file exists to prevent.
 */
export const SHARED_BUCKET = "unattributable";

/**
 * How many proxy hops sit BETWEEN the real client and this process, each of
 * which appends its own address AFTER the client's. See clientIp.
 *
 * Cloud Run + a Cloud Run domain mapping (what this app deploys onto - see
 * .github/workflows/deploy-gcp.yml and docs/LAUNCH-wheeldeal.pro.md, where the
 * apex A/AAAA records point straight at Google) is ZERO: the Google front end
 * appends the client address and nothing follows it. Put a global external
 * Application Load Balancer, Cloudflare or any other proxy in front and each
 * one appends its own address too - set TRUSTED_PROXY_HOPS to how many, or the
 * app keys its limits on that proxy's constant address (one shared bucket:
 * over-strict, never exploitable).
 */
function trustedHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 8) : 0;
}

/** An IPv4/IPv6 literal, with the optional `:port` and `[...]` bracket form removed. */
function normalizeIp(raw: string | undefined): string | null {
  let v = String(raw ?? "").trim();
  if (!v) return null;
  // "[2001:db8::1]:443" / "1.2.3.4:5678" - the port is noise for a rate key and
  // keeping it would let one client occupy many buckets.
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(":")[0];
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const ipv6 = /^[0-9A-Fa-f:]+$/;
  if (!ipv4.test(v) && !(v.includes(":") && ipv6.test(v))) return null;
  return v.toLowerCase();
}

/**
 * The caller's IP, read from the ONE position this platform actually guarantees.
 *
 * HOP 0 IS A VALUE THE ATTACKER WRITES. Google's front end (Cloud Run, and any
 * Google load balancer in front of it) does not replace X-Forwarded-For - it
 * APPENDS the address it observed to whatever the caller already sent. So a
 * request carrying `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <real ip>`,
 * and the leftmost entry - the one this function used to return - is chosen by
 * the client. Rotating it per request bypassed every IP-keyed limit in the app,
 * including the forgot-password throttle whose entire job is to stop a known
 * account being locked out and its inbox flooded.
 *
 * The trustworthy position is therefore the RIGHT-hand end: the last entry was
 * written by infrastructure we run behind, and nothing a client sends can move
 * it. `TRUSTED_PROXY_HOPS` shifts left by the number of extra proxies that
 * appended after it (0 here - see above); anything that cannot be resolved to a
 * real address becomes the shared bucket rather than a free pass.
 *
 * The x-real-ip / cf-connecting-ip / fly-client-ip fallbacks are GONE on
 * purpose: nothing in this deployment writes them, so they were pure
 * attacker-controlled input wearing a trustworthy name.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return SHARED_BUCKET;
  const hops = xff
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const idx = hops.length - 1 - trustedHops();
  if (idx < 0) return SHARED_BUCKET;
  return normalizeIp(hops[idx]) ?? SHARED_BUCKET;
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
