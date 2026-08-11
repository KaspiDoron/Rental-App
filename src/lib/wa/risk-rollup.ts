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
import { RISK_KINDS, noteRisk, type RiskKind } from "./risk-events";
import { looksDeaf } from "./fleet-truth";
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
  /** One reading per instance, carried forward so the next hour has a prior. */
  fleet?: FleetSample;
}

/** `{instance: {state, messages}}` - the two fields `looksDeaf` compares. */
export type FleetSample = Record<string, { state: string | null; messages: number | null }>;

/**
 * THE DEAF-SESSION DETECTOR, FINALLY CONNECTED (W-18).
 *
 * `session_deaf` is a declared risk kind, the dashboard SUMS it
 * (`deaf: sum(buckets, "session_deaf")`), and nothing anywhere emitted it. So
 * that tile has always read a confident zero - the fail-green shape this tier
 * exists to undo, sitting inside the tier itself.
 *
 * `looksDeaf` was written for exactly this and never called. It cannot work on
 * one sample: the condition is an instance that says `open`, that Evolution
 * still lists, and whose message count has NOT MOVED while we were actively
 * sending. Two readings and a send count. The rollup is the only thing in the
 * system that runs on a schedule and can carry a prior forward, so it does.
 *
 * Returns the instance names that look deaf. Pure, so the comparison is
 * testable without a fleet or a database.
 */
export function deafInstances(
  prev: FleetSample | null | undefined,
  next: FleetSample,
  outboundSince: number
): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const [name, cur] of Object.entries(next)) {
    const before = prev[name];
    if (!before) continue; // no prior for this instance - not a judgement
    if (looksDeaf(before, cur, outboundSince)) out.push(name);
  }
  return out.sort();
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

  // ---- The deaf-session pass. Never allowed to cost the bucket. -----------
  //
  // Everything here is best-effort and each failure DARKENS rather than
  // reporting a zero: "we could not tell" and "no instance is deaf" are
  // different facts, and only the second one is reassuring.
  try {
    const { fleetTruth } = await import("./fleet-truth");
    const fleet = await fleetTruth().catch(() => null);
    if (!fleet) {
      snap.dark_signals = [...snap.dark_signals, "deaf:fleet-unreadable"];
    } else {
      const sample: FleetSample = {};
      for (const i of fleet.instances) sample[i.name] = { state: i.state, messages: i.messages };
      snap.fleet = sample;

      const [prior, outbound] = await Promise.all([
        priorFleetSample(from),
        outboundInWindow(from, to),
      ]);
      if (prior === undefined || outbound === null) {
        // No prior (first run, or the migration has not been applied) or an
        // unreadable send count. Either way the detector cannot speak.
        snap.dark_signals = [
          ...snap.dark_signals,
          prior === undefined ? "deaf:no-prior" : "deaf:sends-unreadable",
        ];
      } else {
        for (const name of deafInstances(prior, sample, outbound)) {
          // The instance name is derived from the user's email (a stable
          // hash), which is exactly what `sender_key` wants - and it is the
          // only account identity a fleet listing carries.
          await noteRisk({
            senderKey: name,
            kind: "session_deaf",
            detail: {
              host: fleet.instances.find((i) => i.name === name)?.host ?? "",
              outboundInHour: outbound,
              messages: sample[name]?.messages ?? null,
            },
          });
        }
      }
    }
  } catch {
    snap.dark_signals = [...snap.dark_signals, "deaf:fleet-unreadable"];
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
        ...(snap.fleet ? { fleet: snap.fleet } : {}),
      },
    ],
    "bucket"
  ).catch(() => false);

  return snap;
}

/**
 * The fleet reading from the most recent EARLIER bucket.
 *
 * `undefined` means "no usable prior" - no row, no `fleet` column (the
 * migration has not run), or an unreadable table. All three must darken the
 * detector rather than produce an empty comparison, because comparing against
 * `{}` would find nothing deaf and look exactly like good news.
 */
async function priorFleetSample(beforeIso: string): Promise<FleetSample | undefined> {
  const res = await sbSelectStrict<{ fleet: FleetSample | null }>(
    "wa_risk_snapshots",
    `select=fleet&bucket=lt.${pgTimestamp(beforeIso)}&order=bucket.desc&limit=1`
  );
  if ("error" in res) return undefined;
  const f = res.rows[0]?.fleet;
  return f && typeof f === "object" && Object.keys(f).length > 0 ? f : undefined;
}

/**
 * How many messages we actually sent during the closed hour.
 *
 * `looksDeaf` requires this: a flat message count on an idle instance is an
 * idle instance, not a deaf one, and reporting the difference as deafness
 * would fire on every account overnight. Null = unreadable, which darkens.
 */
async function outboundInWindow(fromIso: string, toIso: string): Promise<number | null> {
  const res = await sbSelectStrict<{ id: number }>(
    "whatsapp_messages",
    `select=id&direction=eq.outbound&received_at=gte.${pgTimestamp(fromIso)}` +
      `&received_at=lt.${pgTimestamp(toIso)}&limit=${ROLLUP_ROW_CAP}`
  );
  if ("error" in res) return res.error === "missing" ? 0 : null;
  return res.rows.length;
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
