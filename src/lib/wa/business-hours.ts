// The recipient-hours decision, in one pure, exported, testable place.
//
// These helpers used to be module-private in wa-guard.ts with ZERO test
// coverage - and they are exactly where the "evening batch deferred to 05:38
// next morning" incident lived: clampToBusinessHours rolled EVERY multi-hour
// hold (intro budget, reply-rate breaker, delivery breaker, daily cap) to the
// next business morning unconditionally, ignoring the fast-dispatch dial that
// was added specifically so batches fire regardless of shop hours. The clamp
// is now flag-aware: under fast dispatch a pacing hold keeps its own horizon,
// it never crosses the night.
//
// Timezone resolution is deliberately coarse (prefix table + region regex) -
// the goal is "never message a shop at 3 AM", not astronomy. Unknown timezone
// means the hours logic stands down entirely: a false "closed" on an open
// shop is the worse bug.

/** The slice of SecurityPolicies the hours decision needs (structural - the
 * full policy object satisfies it). */
export interface HoursPolicy {
  business_hour_start: number;
  business_hour_end: number;
  ignore_business_hours: boolean;
  fast_dispatch: boolean;
}

// Phone prefix -> representative UTC offset (hours).
//
// ORDER IS ENFORCED, NOT ASSUMED. The comment here used to say "longer
// prefixes first" while the list did not honour it ("86" sat above "852" and
// "886"). Nothing broke, because all three share offset 8 - but the next
// person to add a prefix inherits a trap. `PREFIX_UTC` is sorted
// longest-first at module load below, so the list can be written in whatever
// order reads well and the lookup is still correct by construction.
const PREFIX_UTC_RAW: [string, number][] = [
  ["972", 2], // Israel
  ["351", 0], // Portugal
  ["66", 7], // Thailand
  ["62", 8], // Indonesia (Bali)
  ["84", 7], // Vietnam
  ["91", 5.5], // India
  ["81", 9], // Japan
  ["82", 9], // South Korea
  ["63", 8], // Philippines
  ["60", 8], // Malaysia
  ["65", 8], // Singapore
  ["86", 8], // China
  ["852", 8], // Hong Kong
  ["886", 8], // Taiwan
  ["90", 3], // Turkey
  ["971", 4], // UAE
  ["966", 3], // Saudi
  ["20", 2], // Egypt
  ["212", 1], // Morocco
  ["27", 2], // South Africa
  ["254", 3], // Kenya
  ["94", 5.5], // Sri Lanka
  ["977", 5.75], // Nepal
  ["52", -6], // Mexico
  ["55", -3], // Brazil
  ["54", -3], // Argentina
  ["57", -5], // Colombia
  ["51", -5], // Peru
  ["56", -4], // Chile
  ["61", 10], // Australia (east)
  ["64", 12], // New Zealand
  ["44", 0], // UK
  ["34", 1], ["39", 1], ["33", 1], ["49", 1], ["30", 2], ["31", 1],
  ["48", 1], ["420", 1], ["36", 1], ["46", 1], ["47", 1], ["45", 1], ["7", 3],
  ["1", -5], // US/CA (east-coast bias)
  // SOUTH-EAST ASIA'S MISSING FIVE (owner report 8).
  //
  // Cambodia, Laos, Myanmar, Bangladesh and the Maldives were absent from both
  // this table AND the region regexes below - and `resolveOffset` returning
  // `known: false` does not merely lose precision, it DISABLES the clock gate
  // entirely (`if (known && ...)` in wa-guard). So a cold first contact to a
  // rental shop in Siem Reap, Vientiane or Yangon could fire at 03:00 local:
  // exactly the pattern this module exists to prevent, in core markets for a
  // scooter-rental app.
  ["855", 7], // Cambodia
  ["856", 7], // Laos
  ["95", 6.5], // Myanmar
  ["880", 6], // Bangladesh
  ["960", 5], // Maldives
];

/** Longest prefix first, so "852" can never be shadowed by "86". */
const PREFIX_UTC: [string, number][] = [...PREFIX_UTC_RAW].sort(
  (a, b) => b[0].length - a[0].length
);

// Region-string -> UTC offset. More reliable than a bare local number, because
// the geocoded region almost always ends in the country name.
const REGION_UTC: [RegExp, number][] = [
  [/\bthai|\bthailand/i, 7], [/\bindonesia|\bbali/i, 8], [/\bvietnam/i, 7],
  [/\bindia\b|\bgoa\b/i, 5.5], [/\bjapan/i, 9], [/\bkorea/i, 9],
  [/\bphilippin/i, 8], [/\bmalaysia/i, 8], [/\bsingapore/i, 8],
  [/\bchina\b/i, 8], [/\bhong kong/i, 8], [/\btaiwan/i, 8],
  [/\bturkey|\btürkiye/i, 3], [/\bemirates|\bdubai|\buae\b/i, 4], [/\bsaudi/i, 3],
  [/\begypt/i, 2], [/\bmorocco/i, 1], [/\bsouth africa/i, 2], [/\bkenya/i, 3],
  [/\bsri lanka/i, 5.5], [/\bnepal/i, 5.75], [/\bisrael/i, 2],
  [/\bcambodia|\bsiem reap|\bphnom penh/i, 7], [/\blaos\b|\bvientiane|\bluang prabang/i, 7],
  [/\bmyanmar|\bburma|\byangon/i, 6.5], [/\bbangladesh|\bdhaka/i, 6],
  [/\bmaldives|\bmal\u00e9\b/i, 5],
  [/\bmexico/i, -6], [/\bbrazil|\bbrasil/i, -3], [/\bargentin/i, -3],
  [/\bcolombia/i, -5], [/\bperu/i, -5], [/\bchile/i, -4],
  [/\baustralia/i, 10], [/\bnew zealand/i, 12],
  [/\bunited kingdom|\bengland|\bscotland|\bwales|\blondon/i, 0],
  [/\bportugal/i, 0], [/\bspain|\bitaly|\bfrance|\bgermany|\bnetherlands|\bbelgium|\baustria|\bpoland|\bczech|\bhungary/i, 1],
  [/\bgreece\b/i, 2], [/\bsweden|\bnorway|\bdenmark/i, 1], [/\brussia|\bmoscow/i, 3],
  [/\bunited states|\busa\b|\bcanada/i, -5],
];

/** Returns the offset AND whether we actually know it (unknown => never queue
 * on hours; a false "closed" is worse UX than a rare off-hours send). */
export function resolveOffset(digits: string, region?: string): { off: number; known: boolean } {
  for (const [prefix, off] of PREFIX_UTC) {
    if (digits.startsWith(prefix)) return { off, known: true };
  }
  if (region) {
    for (const [re, off] of REGION_UTC) if (re.test(region)) return { off, known: true };
  }
  return { off: 0, known: false };
}

/** Recipient's local hour at `nowMs` (0-23, fractional offsets floored). */
export function recipientLocalHour(toDigits: string, region?: string, nowMs: number = Date.now()): number {
  const { off } = resolveOffset(toDigits, region);
  const d = new Date(nowMs);
  const h = (d.getUTCHours() + d.getUTCMinutes() / 60 + off + 24) % 24;
  return Math.floor(h);
}

/** Next moment the recipient's business window opens, as ISO string. */
export function nextBusinessOpen(
  toDigits: string,
  p: HoursPolicy,
  region?: string,
  nowMs: number = Date.now(),
  rand: () => number = Math.random
): string {
  const { off } = resolveOffset(toDigits, region);
  const d = new Date(nowMs);
  const localHour = (d.getUTCHours() + d.getUTCMinutes() / 60 + off + 24) % 24;
  let waitHours: number;
  if (localHour < p.business_hour_start) {
    waitHours = p.business_hour_start - localHour;
  } else {
    waitHours = 24 - localHour + p.business_hour_start;
  }
  // Add 0-40 min of jitter so queued sends don't all fire at 9:00:00 sharp.
  const jitterMs = Math.floor(rand() * 40 * 60_000);
  return new Date(nowMs + waitHours * 3600_000 + jitterMs).toISOString();
}

/**
 * If `iso` lands outside the recipient's known business window, roll it
 * forward to the next open. It stands down entirely when:
 *   - fast dispatch / ignore-business-hours is on (the 24/7 dial - the whole
 *     point of the dial is that NO hold rolls to the next morning), or
 *   - the timezone is unknown (never false-delay an open shop).
 */
export function clampToBusinessHours(
  iso: string,
  toDigits: string,
  p: HoursPolicy,
  region?: string,
  rand: () => number = Math.random
): string {
  if (p.fast_dispatch || p.ignore_business_hours) return iso;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const { off, known } = resolveOffset(toDigits, region);
  if (!known) return iso;
  const localH = (new Date(at).getUTCHours() + new Date(at).getUTCMinutes() / 60 + off + 24) % 24;
  if (localH >= p.business_hour_start && localH < p.business_hour_end) return iso;
  const waitHours =
    localH < p.business_hour_start
      ? p.business_hour_start - localH
      : 24 - localH + p.business_hour_start;
  const jitterMs = Math.floor(rand() * 30 * 60_000);
  return new Date(at + waitHours * 3600_000 + jitterMs).toISOString();
}

/**
 * Cap a hold at `maxHours` from now. Anti-ban holds (breakers, budget waits)
 * must self-expire inside the plan's own window - a freeze that outlives the
 * window it protects has become a wall, not a pace.
 */
export function boundHold(iso: string, nowMs: number, maxHours: number): string {
  const at = Date.parse(iso);
  const cap = nowMs + Math.max(0, maxHours) * 3600_000;
  if (!Number.isFinite(at) || at <= cap) return iso;
  return new Date(cap).toISOString();
}
