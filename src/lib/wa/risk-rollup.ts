// THE HOURLY ROLLUP, AND THE REPORT THAT READS ONLY IT - plan Part 9.7.
//
// The dashboard must answer from a handful of rows regardless of how many
// accounts exist. `/api/activity` is the counter-example already in this repo:
// ~21 Supabase round trips per tick, plus two awaited 8-second WhatsApp drains
// before it reads anything. At fleet scale a live fan-out monitor becomes the
// load it monitors, and a risk dashboard that degrades the fleet it is watching
// is worse than no dashboard.
//
// So: a scheduled job aggregates one hour into one row, and the panel reads the
// last N rows. Nothing on the read path touches the event table.

import { sbSelectStrict, sbInsert, pgTimestamp } from "../runtime-config";
import { RISK_KINDS, type RiskKind } from "./risk-events";
import { worseOf, rollupStale, type TileState } from "./risk-verdict";

export const BUCKET_MS = 3_600_000;

/**
 * How many events one bucket will read before it gives up counting.
 *
 * Bounded because this runs on a schedule against an append-only table that
 * only grows. A truncated bucket is MARKED truncated rather than quietly
 * short - rule E9 - because a count that silently stopped at the cap and a
 * count that genuinely ended there are different facts, and only one of them
 * is safe to divide by.
 */
export const ROLLUP_ROW_CAP = 2000;

export function bucketStart(nowMs: number): number {
  return Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
}

export interface RiskSnapshot {
  bucket: string;
  accounts: number;
  counts: Partial<Record<RiskKind, number>>;
  dark_signals: string[];
  truncated_signals: string[];
}

interface RawEvent {
  sender_key: string;
  kind: string;
}

/**
 * Aggregate one hour of raw events. Pure, so the counting is testable without a
 * database - which is the only way it will actually be tested.
 */
export function aggregate(
  rows: RawEvent[],
  opts: { truncated: boolean }
): Omit<RiskSnapshot, "bucket"> {
  const counts: Partial<Record<RiskKind, number>> = {};
  const senders = new Set<string>();
  for (const r of rows) {
    if (r.sender_key) senders.add(r.sender_key);
    const k = r.kind as RiskKind;
    if (!RISK_KINDS.includes(k)) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return {
    accounts: senders.size,
    counts,
    dark_signals: [],
    // E9: the marker travels WITH the numbers. A truncated bucket whose cap is
    // recorded somewhere else is a truncated bucket nobody will notice.
    truncated_signals: opts.truncated ? ["events"] : [],
  };
}

/**
 * Compute and persist one bucket. Returns the snapshot, or null when the source
 * could not be read.
 *
 * AN UNREADABLE HOUR IS WRITTEN AS DARK, NOT SKIPPED. Skipping it would leave a
 * gap that the panel cannot distinguish from an hour in which nothing happened -
 * and "nothing happened" is exactly what a dead sensor looks like. This is the
 * fail-green failure the whole tier exists to avoid, in its most tempting form,
 * because writing nothing feels like the conservative choice.
 */
export async function rollupBucket(nowMs: number): Promise<RiskSnapshot | null> {
  const start = bucketStart(nowMs) - BUCKET_MS; // the hour that just closed
  const from = new Date(start).toISOString();
  const to = new Date(start + BUCKET_MS).toISOString();

  const res = await sbSelectStrict<RawEvent>(
    "wa_risk_events",
    `select=sender_key,kind&at=gte.${pgTimestamp(from)}&at=lt.${pgTimestamp(to)}&order=at.desc&limit=${ROLLUP_ROW_CAP}`
  );

  let snap: RiskSnapshot;
  if ("error" in res) {
    snap = {
      bucket: from,
      accounts: 0,
      counts: {},
      // "missing" means the table is not there yet, which is a real and
      // recoverable deployment state; "unavailable" means an outage. Both are
      // dark, and the reason is kept so the panel can say which.
      dark_signals: [res.error === "missing" ? "events:missing" : "events:unavailable"],
      truncated_signals: [],
    };
  } else {
    snap = { bucket: from, ...aggregate(res.rows, { truncated: res.rows.length >= ROLLUP_ROW_CAP }) };
  }

  await sbInsert(
    "wa_risk_snapshots",
    [
      {
        bucket: snap.bucket,
        computed_at: new Date(nowMs).toISOString(),
        accounts: snap.accounts,
        counts: snap.counts,
        dark_signals: snap.dark_signals,
        truncated_signals: snap.truncated_signals,
      },
    ],
    "bucket"
  ).catch(() => false);

  return snap;
}

// RULE E8 - a snapshot older than two periods darkens the WHOLE panel, not the
// tile it came from. If the rollup stopped running, every number on the screen
// is stale by an unknown amount, and a screen of stale numbers with no
// indication is strictly more dangerous than an empty one.
//
// `rollupStale` is imported rather than re-implemented. A second staleness rule
// is how one surface calls an hour fresh while another calls it dark, which is
// the whole class of defect this tier is cleaning up.

export interface RiskReport {
  /** Newest first. */
  buckets: RiskSnapshot[];
  /** Age of the newest bucket, in hours. Null when there is no bucket at all. */
  staleHours: number | null;
  stale: boolean;
  /** Totals across the window, per axis. */
  velocity: { intros: number; answered: number; suspected: number };
  client: { logouts: number; forbidden: number; replaced: number; deaf: number };
  meter: { delivered: number; read: number; failed: number; invalid: number; blocked: number };
  /** Every distinct dark reason seen in the window. */
  dark: string[];
  truncated: boolean;
  /** Worst state across the window - never better than its darkest input. */
  verdict: TileState;
}

const sum = (b: RiskSnapshot[], k: RiskKind) => b.reduce((n, s) => n + (s.counts[k] ?? 0), 0);

/**
 * Read the rollup and shape it for the panel. Two Supabase round trips, total,
 * whatever the fleet size.
 */
export async function riskReport(nowMs: number, hours = 24): Promise<RiskReport> {
  const since = new Date(bucketStart(nowMs) - hours * BUCKET_MS).toISOString();
  const res = await sbSelectStrict<{
    bucket: string;
    accounts: number;
    counts: Partial<Record<RiskKind, number>> | null;
    dark_signals: string[] | null;
    truncated_signals: string[] | null;
  }>(
    "wa_risk_snapshots",
    `select=bucket,accounts,counts,dark_signals,truncated_signals&bucket=gte.${pgTimestamp(since)}&order=bucket.desc&limit=${hours + 2}`
  );

  if ("error" in res) {
    // The panel cannot read its own rollup. Everything below would be invented.
    return {
      buckets: [],
      staleHours: null,
      stale: true,
      velocity: { intros: 0, answered: 0, suspected: 0 },
      client: { logouts: 0, forbidden: 0, replaced: 0, deaf: 0 },
      meter: { delivered: 0, read: 0, failed: 0, invalid: 0, blocked: 0 },
      dark: [res.error === "missing" ? "snapshots:missing" : "snapshots:unavailable"],
      truncated: false,
      verdict: "dark",
    };
  }

  const buckets: RiskSnapshot[] = res.rows.map((r) => ({
    bucket: r.bucket,
    accounts: r.accounts ?? 0,
    counts: r.counts ?? {},
    dark_signals: r.dark_signals ?? [],
    truncated_signals: r.truncated_signals ?? [],
  }));

  const staleness = rollupStale(buckets[0]?.bucket ?? null, BUCKET_MS, nowMs);
  const stale = staleness.stale;
  const dark = [...new Set(buckets.flatMap((b) => b.dark_signals))];
  const truncated = buckets.some((b) => b.truncated_signals.length > 0);

  // The verdict is worst-of and can never be better than its darkest input. A
  // panel that averages its way back to green over a dark hour is the same bug
  // with arithmetic in front of it.
  const states: TileState[] = [];
  if (buckets.length === 0) states.push("empty");
  if (dark.length > 0 || stale) states.push("dark");
  if (sum(buckets, "restriction_suspected") > 0) states.push("warn");
  if (sum(buckets, "restriction_confirmed") > 0) states.push("critical");
  if (sum(buckets, "session_forbidden") > 0) states.push("critical");
  if (states.length === 0) states.push("ok");

  return {
    buckets,
    staleHours:
      staleness.ageMs === null ? null : Math.round((staleness.ageMs / BUCKET_MS) * 10) / 10,
    stale,
    velocity: {
      intros: sum(buckets, "intro_sent"),
      answered: sum(buckets, "intro_answered"),
      suspected: sum(buckets, "restriction_suspected"),
    },
    client: {
      logouts: sum(buckets, "session_logged_out"),
      forbidden: sum(buckets, "session_forbidden"),
      replaced: sum(buckets, "session_replaced"),
      deaf: sum(buckets, "session_deaf"),
    },
    meter: {
      delivered: sum(buckets, "delivery_receipt"),
      read: sum(buckets, "read_receipt"),
      failed: sum(buckets, "send_failed"),
      invalid: sum(buckets, "recipient_invalid"),
      blocked: sum(buckets, "recipient_blocked"),
    },
    dark,
    truncated,
    verdict: states.reduce<TileState>((acc, s2) => worseOf(acc, s2), "empty"),
  };
}
