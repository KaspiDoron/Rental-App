// THE SITE HAS ONE IDENTITY, AND ONE PLACE THAT KNOWS IT.
//
// Before this file the brand domain was a bare string literal in three
// unrelated modules - the root layout's metadata base, the Web Push sender
// identity, and the Nominatim User-Agent - written in three different shapes
// (a full origin, a bare host, "either"), each with its own env fallback chain
// and its own normalising. That is why changing the domain was an audit rather
// than an edit: nothing owned the answer, so every consumer had re-derived it.
//
// One module owns it now. A consumer asks for an origin or a host and gets a
// normalised one; the resolution ORDER is written once; and the next rename is
// a single constant.

/** The brand domain. The one place a rename happens. */
export const SITE_DOMAIN = "wheeldeal.pro";

/** The canonical public origin - scheme included, no trailing slash. */
export const SITE_ORIGIN = `https://${SITE_DOMAIN}`;

/**
 * Google AdSense publisher id. Public by design (it ships in the page source,
 * in `ads.txt` and in every ad request), so it is a constant rather than a
 * secret - the site must serve a correct `ads.txt` and a correct account meta
 * tag from the very first deploy, before anyone has pasted anything into the
 * Key Vault, or Google's review fails on an unverifiable site.
 */
export const ADSENSE_PUBLISHER = "ca-pub-4965894186804157";

/** `ads.txt` names the publisher WITHOUT the "ca-" prefix. */
export const ADSENSE_PUB_ID = ADSENSE_PUBLISHER.replace(/^ca-/, "");

/**
 * Accept anything an owner might paste - "wheeldeal.pro", "wheeldeal.pro/",
 * "https://wheeldeal.pro" - and return one canonical origin, or null if it is
 * not a usable host. Every entry point normalises through here, so a trailing
 * slash pasted into Admin can never produce a double-slashed share link or a
 * CORS origin that fails to match.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v.startsWith("http") ? v : `https://${v}`);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The origin from the BUILD environment only. Synchronous, so it is safe at
 * module scope and during static generation, where the Key Vault (a network
 * call) is not available.
 */
export function envSiteOrigin(): string {
  return (
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizeOrigin(process.env.APP_DOMAIN) ||
    SITE_ORIGIN
  );
}

/**
 * The live origin: the owner-set APP_DOMAIN in the Key Vault wins (so a domain
 * move needs no redeploy), then the build env, then the brand default.
 *
 * `runtime-config` is imported lazily so that importing a constant from this
 * module never drags the Supabase client into a client bundle or a build-time
 * evaluation.
 */
export async function resolveSiteOrigin(): Promise<string> {
  try {
    const { getConfig } = await import("@/lib/runtime-config");
    const fromVault = normalizeOrigin(await getConfig("APP_DOMAIN"));
    if (fromVault) return fromVault;
  } catch {
    /* build-time / keyless: the env chain below is the answer */
  }
  return envSiteOrigin();
}

/** The live hostname - "wheeldeal.pro" - for anything that wants a bare host. */
export async function resolveSiteHost(): Promise<string> {
  try {
    return new URL(await resolveSiteOrigin()).hostname;
  } catch {
    return SITE_DOMAIN;
  }
}
