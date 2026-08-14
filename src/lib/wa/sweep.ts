// Pure fair-rotation for the scheduler's inbound-recovery sweep. The webhook is
// the primary inbound path; this sweep is the app-CLOSED backstop that pulls
// recent shop replies straight from Evolution for a few senders each tick. To
// stay cheap it processes at most N senders per tick, rotating by minute-of-day
// so every active sender is covered over the hour without a per-user timer.

/** Deterministically pick up to `n` emails for this minute, rotating the window
 * across the sorted sender list so coverage is fair over ~an hour. */
export function pickSweepEmails(emails: string[], minute: number, n: number): string[] {
  const unique = [...new Set(emails.filter(Boolean))].sort();
  if (unique.length === 0 || n <= 0) return [];
  if (unique.length <= n) return unique;
  const start = ((minute % unique.length) + unique.length) % unique.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(unique[(start + i) % unique.length]);
  return out;
}

/**
 * How many senders to sweep per minute, PROPORTIONAL to the fleet (owner report
 * 4, scale #9). A fixed 3/min meant a full rotation of the sender list took
 * `ceil(fleet/3)` minutes - fine at a dozen users, but at 300 that is a
 * 100-minute worst-case gap between app-closed recovery sweeps for any one
 * shop. Scale it to ceil(fleet/20) so the whole fleet is covered within ~20
 * minutes regardless of size, floored at 3 (never regress small deployments)
 * and capped at 10 (one cron minute cannot fan out unbounded work). Pure.
 */
export function sweepCapForFleet(fleetSize: number): number {
  return Math.min(10, Math.max(3, Math.ceil(fleetSize / 20)));
}

/** Rotate a WINDOW of `size` items across `items`, advancing a full window per
 * tick - so over ceil(len/size) ticks EVERY item is visited. The per-thread
 * sweep uses this: always taking the newest N meant the older shops of a big
 * batch were never swept and their missed replies stayed missed forever. */
export function rotateWindow<T>(items: T[], tick: number, size: number): T[] {
  if (size <= 0) return [];
  if (items.length <= size) return items;
  const start = (((tick * size) % items.length) + items.length) % items.length;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(items[(start + i) % items.length]);
  return out;
}
