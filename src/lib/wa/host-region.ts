/**
 * WHICH EVOLUTION HOST SHOULD CARRY THIS NUMBER.
 *
 * Independent 2026 research on unofficial WhatsApp stacks agrees on two
 * network-level ban signals, and our fleet was blind to both:
 *
 *   1. Datacenter IP ranges are scored. Unavoidable for us - the owner has
 *      ruled out a residential box, so every lane is a datacenter lane.
 *   2. IP-vs-number GEO MISMATCH is scored SEPARATELY. A Thai number
 *      transmitting from an Oregon datacenter is an anomaly on its own, and
 *      that was literally our whole fleet: one Render box in `oregon` carrying
 *      numbers whose shops are in south-east Asia.
 *
 * We cannot fix (1) at $0. We CAN fix (2), because it costs nothing: it is
 * purely a question of which host a user is placed on at link time, and the
 * free tiers we are moving to (Oracle Always Free, Azure's 12-month B1s,
 * Northflank Sandbox) all offer regions in the places our testers will be.
 *
 * `EVOLUTION_HOSTS` therefore takes an OPTIONAL third field - the calling-code
 * prefixes that host is geographically right for:
 *
 *     https://sg.example.com|API_KEY|66,84,855,856,60,65
 *     https://eu.example.com|API_KEY|33,34,39,49,44
 *     https://any.example.com|API_KEY
 *
 * Dial prefixes rather than country names or ISO codes on purpose: they are
 * what every other routing decision in this codebase already keys on, so there
 * is no second country table to drift out of sync with the first.
 *
 * A host with no third field is REGION-NEUTRAL, which is exactly what every
 * existing single-field line already means - so nothing about a deployment
 * that has not opted in changes.
 */

/** One host's routing identity. `dialPrefixes` empty = region-neutral. */
export interface RegionalHost {
  url: string;
  dialPrefixes: string[];
}

/**
 * Parse the optional third field. Digits only, longest-first so matching is
 * unambiguous, deduped, and silently tolerant of junk - a typo in one prefix
 * must never take a host out of the fleet, it just narrows what it claims.
 */
export function parseDialPrefixes(raw: string | undefined | null): string[] {
  const out = new Set<string>();
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const d = part.replace(/\D/g, "");
    if (d) out.add(d);
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The LONGEST prefix this host claims that the number actually starts with, or
 * null. Length matters: a host claiming "1" (all of North America) and one
 * claiming "1868" (Trinidad) must not tie, and the more specific claim wins.
 */
export function prefixMatchLength(host: RegionalHost, digits: string): number | null {
  const n = String(digits ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!n) return null;
  for (const p of host.dialPrefixes) if (n.startsWith(p)) return p.length;
  return null;
}

/** Where a host sits for a given number. Lower is better. */
export type HostAffinity = 0 | 1 | 2;
export const AFFINITY_MATCH: HostAffinity = 0;
export const AFFINITY_NEUTRAL: HostAffinity = 1;
export const AFFINITY_MISMATCH: HostAffinity = 2;

/**
 * THREE TIERS, and the third one is not a bug.
 *
 *   0  the host claims this number's country - the whole point.
 *   1  the host claims nothing, so it is not WRONG for anyone. Every host in a
 *      deployment that has not opted in is here, which is why opting in is
 *      strictly additive.
 *   2  the host claims OTHER countries. Still usable, deliberately: a
 *      geo-mismatched link is a scored signal, and NO link at all is a user who
 *      cannot use the product. We rank it last and take it only if nothing
 *      better has capacity.
 *
 * With no number known (a placement before we have learned the phone) every
 * host is neutral, so ranking degrades exactly to load order.
 */
export function affinityFor(host: RegionalHost, digits: string | null | undefined): HostAffinity {
  if (!host.dialPrefixes.length) return AFFINITY_NEUTRAL;
  if (!digits) return AFFINITY_NEUTRAL;
  return prefixMatchLength(host, digits) === null ? AFFINITY_MISMATCH : AFFINITY_MATCH;
}

/**
 * Order candidate hosts for a number: affinity tier first, then the most
 * specific claim inside the matching tier, then the caller's existing
 * least-loaded ordering (passed in as `load`), then a stable tiebreak.
 *
 * Pure and total - it never drops a host, so a caller's capacity rules stay
 * the only thing that can refuse a placement. Sorting a copy, because the
 * caller's array is its own.
 */
export function rankHostsForNumber<T extends RegionalHost>(
  hosts: readonly T[],
  digits: string | null | undefined,
  load: (h: T) => number,
  tiebreak?: (h: T) => number
): T[] {
  return [...hosts].sort((a, b) => {
    const aff = affinityFor(a, digits) - affinityFor(b, digits);
    if (aff !== 0) return aff;
    // Inside the matching tier, the more specific claim wins.
    const spec = (prefixMatchLength(b, String(digits ?? "")) ?? 0) -
      (prefixMatchLength(a, String(digits ?? "")) ?? 0);
    if (spec !== 0) return spec;
    const byLoad = load(a) - load(b);
    if (byLoad !== 0) return byLoad;
    if (tiebreak) {
      const t = tiebreak(a) - tiebreak(b);
      if (t !== 0) return t;
    }
    return a.url.localeCompare(b.url);
  });
}

/**
 * Did this placement end up geo-correct? Reported so the owner panel can show
 * "3 of 12 numbers are on a mismatched host" instead of the fleet looking
 * uniformly healthy while a scored signal quietly accumulates.
 */
export function mismatchCount(
  placements: readonly { host: RegionalHost; digits: string | null }[]
): number {
  return placements.filter((p) => affinityFor(p.host, p.digits) === AFFINITY_MISMATCH).length;
}
