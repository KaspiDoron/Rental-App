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
 * `x-forwarded-host` IS CLIENT INPUT. Anyone can send it.
 *
 * `requestOrigin` above believes it, and that is correct for what it was
 * written for - deciding whether a link should say 0.0.0.0:8080 or the real
 * host. It is NOT correct for the three things that grew on top of it:
 *
 *   - `selfKickOrigin`, which the app fetches. A signed-in user sending
 *     `x-forwarded-host: attacker.example` made the server issue that request
 *     instead - a server-side request forgery with our own credentials.
 *   - `canonicalWebhookOrigin`, which REGISTERS the resulting URL on Evolution
 *     as `<origin>/api/webhooks/evolution?token=<webhookToken>`. With APP_DOMAIN
 *     unset or unreadable the forwarded host was the only candidate, so one
 *     header sent the webhook token to a stranger AND redirected every shop
 *     reply, for every user on that instance, to their server.
 *   - the PayPal return URL, which would send a payer to an attacker's page
 *     wearing our checkout's identity.
 *
 * So: an ALLOW-LIST, checked against origins the OWNER controls.
 *
 *   1. the live site origin (APP_DOMAIN in the vault, then NEXT_PUBLIC_SITE_URL
 *      / APP_DOMAIN from the build env, then the brand default);
 *   2. `TRUSTED_HOSTS`, a comma-separated vault list, so the owner can add the
 *      GCP gateway URL or a preview host without a redeploy.
 *
 * Anything else answers null and the caller falls back to the canonical origin.
 * A misconfigured host then produces a wrong-but-ours URL, which is loud and
 * fixable in Admin; the previous behaviour produced a right-looking URL pointed
 * at whoever asked, which is silent.
 */
export async function trustedRequestOrigin(req: Request): Promise<string | null> {
  const candidate = publicRequestOrigin(req);
  if (!candidate) return null;
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
  const allowed = new Set<string>();
  const add = (s?: string | null) => {
    const o = routableOrigin(s);
    if (!o) return;
    try {
      allowed.add(new URL(o).hostname.toLowerCase());
    } catch {
      /* not a host we can compare */
    }
  };
  try {
    const { resolveSiteOrigin } = await import("@/lib/site");
    add(await resolveSiteOrigin());
  } catch {
    /* keyless/build-time: the env entries below still apply */
  }
  add(process.env.NEXT_PUBLIC_SITE_URL);
  add(process.env.APP_DOMAIN);
  try {
    const { getConfig } = await import("@/lib/runtime-config");
    // An UNREADABLE list must not widen the allow-list - getConfig returns
    // undefined on a vault outage, which yields no extra hosts. That is the
    // fail-closed direction: fewer trusted hosts, never more.
    for (const h of String((await getConfig("TRUSTED_HOSTS")) ?? "").split(",")) {
      if (h.trim()) add(h.trim());
    }
  } catch {
    /* vault unreachable: the canonical origin above is the whole allow-list */
  }
  return allowed.has(host) ? candidate : null;
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
 *      it is a bind/loopback/link-local address no fetch could reach AND
 *      rejected if it is not a host the owner controls - see
 *      `trustedRequestOrigin`. Step 1 used to be `publicRequestOrigin`, which
 *      is client input: any caller could point the server's own fetch at their
 *      server by sending one header;
 *   2. the owner-set APP_DOMAIN / env origin, which is always routable.
 *
 * Every self-directed URL in this codebase MUST come from here. There is a test
 * asserting no route builds one from `req.url` directly.
 */
export async function selfKickOrigin(req: Request): Promise<string> {
  const fromRequest = await trustedRequestOrigin(req);
  if (fromRequest) return fromRequest;
  const { resolveSiteOrigin } = await import("@/lib/site");
  return resolveSiteOrigin();
}
