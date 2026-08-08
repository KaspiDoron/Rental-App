// Proxy-aware public-origin resolution.
//
// On Cloud Run the Next.js standalone server builds `req.url` from the bind
// address (HOSTNAME=0.0.0.0, PORT=8080), NOT from the proxy's Host header - so
// `new URL(req.url).origin` is the unroutable `https://0.0.0.0:8080`. The real
// public host rides in on `x-forwarded-host` + `x-forwarded-proto`, which every
// GCP front proxy sets. These helpers prefer the forwarded identity and can
// reject origins that no external service could ever reach (used before
// registering a webhook URL on Evolution - a 0.0.0.0 webhook is worse than
// none).

/** Normalize to an https?:// origin; null when the host is unroutable from the
 * outside (bind addresses, loopback, link-local, *.internal). */
export function routableOrigin(s?: string | null): string | null {
  if (!s) return null;
  let v = s.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // Every externally-reachable host has a dot (wheeldeal.app, *.run.app, an
  // IPv4). Dotless names are bind aliases, container hostnames or typos.
  if (!host.includes(".") ) return null;
  if (
    host === "0.0.0.0" ||
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host === "[::]" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.startsWith("169.254.") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return null;
  }
  return u.origin;
}

/**
 * The public origin of a request as the OUTSIDE world sees it:
 * x-forwarded-proto + x-forwarded-host (first value; proxies append
 * comma-separated) when present, else the raw request URL's origin. No
 * routability filter - localhost stays valid for local dev. Feed the result
 * through `routableOrigin` when the origin must be reachable externally.
 */
export function requestOrigin(req: Request): string {
  const rawHost = req.headers.get("x-forwarded-host");
  const host = rawHost?.split(",")[0]?.trim();
  if (host) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      /* fall through to the raw URL */
    }
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

/** requestOrigin, but only if an external service could actually reach it. */
export function publicRequestOrigin(req: Request): string | null {
  return routableOrigin(requestOrigin(req));
}

/**
 * The origin to use when this app calls ITSELF - the dispatcher self-kicks that
 * drive the reply lane and the tick chain.
 *
 * THIS IS THE ONE THAT WAS BROKEN. Every self-kick used to build its URL from
 * `new URL(req.url).origin`, which on Cloud Run resolves to the bind address
 * `http://0.0.0.0:8080` (Dockerfile sets HOSTNAME=0.0.0.0, PORT=8080). The
 * fetch then failed against an unroutable host, `kickDispatcher` swallowed it
 * by design, and the dispatcher was never started - so composed replies sat in
 * the outbox and shops got silence. It was the common ancestor of a long line
 * of "queue stuck" incidents.
 *
 * Resolution order, and each step matters:
 *   1. the forwarded identity (what the outside world called us), rejected if
 *      it is a bind/loopback/link-local address no fetch could reach;
 *   2. the owner-set APP_DOMAIN / env origin, which is always routable.
 *
 * Every self-directed URL in this codebase MUST come from here. There is a test
 * asserting no route builds one from `req.url` directly.
 */
export async function selfKickOrigin(req: Request): Promise<string> {
  const fromRequest = publicRequestOrigin(req);
  if (fromRequest) return fromRequest;
  const { resolveSiteOrigin } = await import("@/lib/site");
  return resolveSiteOrigin();
}
