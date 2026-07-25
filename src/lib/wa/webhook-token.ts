// Webhook token derivation + URL classification (pure, unit-testable).
//
// The Evolution webhook URL carries a token derived from SESSION_SECRET so only
// our server can post inbound events. When SESSION_SECRET is rotated the derived
// token changes; if Evolution still holds a URL with the OLD token, every event
// 403s. The fix is to RE-ARM Evolution's stored URL with the CURRENT token (see
// reassertWebhook in evolution.ts). These helpers are the pure core of that:
// deriving the current token and classifying whatever URL Evolution reports.
//
// Kept dependency-light (only node crypto) so it tests without env mutation and
// without pulling the server-only evolution.ts graph.

import { createHash } from "crypto";

// A predictable fallback secret would make the webhook/ping token guessable, so
// it is only ever used off-production (mirrors evolution.ts:242-245).
const DEV_FALLBACK = createHash("sha256").update("wd-webhook:dev-only").digest("hex").slice(0, 32);

/** The CURRENT webhook token for a given secret. Mirrors evolution.ts:237-247
 * exactly (sha256("wd-webhook:"+secret).slice(0,32); a <16-char secret yields a
 * dev-only token off-production, null in production). */
export function deriveWebhookToken(opts: { secret?: string | null; nodeEnv?: string }): string | null {
  const secret = opts.secret;
  if (!secret || secret.length < 16) {
    return opts.nodeEnv === "production" ? null : DEV_FALLBACK;
  }
  return createHash("sha256").update(`wd-webhook:${secret}`).digest("hex").slice(0, 32);
}

export type TokenState = "current" | "foreign" | "none";

/** Compare a presented token against the current one. */
export function classifyToken(presented: string | null | undefined, current: string | null): TokenState {
  if (!presented) return "none";
  if (current && presented === current) return "current";
  return "foreign";
}

/** Does a registered webhook URL already point at our canonical target with the
 * current token? Tolerant of a trailing slash and extra query params. Pure. */
export function sameWebhookTarget(
  registeredUrl: string | null | undefined,
  origin: string,
  token: string
): boolean {
  if (!registeredUrl) return false;
  try {
    const u = new URL(registeredUrl);
    const expected = new URL(`${origin}/api/webhooks/evolution`);
    if (u.origin !== expected.origin) return false;
    if (u.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) return false;
    return u.searchParams.get("token") === token;
  } catch {
    return false;
  }
}

/** Classify whatever webhook URL Evolution reports for the WA doctor: is the
 * token current/foreign/absent, and does the origin match our canonical one? */
export function classifyRegisteredWebhook(
  registeredUrl: string | null | undefined,
  currentToken: string | null,
  canonicalOrigin: string | null
): { tokenState: TokenState; originMatch: boolean | null } {
  if (!registeredUrl) return { tokenState: "none", originMatch: null };
  try {
    const u = new URL(registeredUrl);
    const presented = u.searchParams.get("token");
    const originMatch = canonicalOrigin ? u.origin === new URL(canonicalOrigin).origin : null;
    return { tokenState: classifyToken(presented, currentToken), originMatch };
  } catch {
    return { tokenState: "none", originMatch: false };
  }
}
