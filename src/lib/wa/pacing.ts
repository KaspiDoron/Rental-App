import "server-only";
import { createHash } from "crypto";
import { sbDelete, sbInsertClaim, sbSelectStrict } from "../runtime-config";
import { digitsOnly } from "../phone";

// Pacing primitives for the anti-ban engine.
//
// Two problems live here:
//  1. THUNDERING HERD - cap holds used to stamp a flat now+offset on every
//     held message, so a whole batch released at the same instant (the
//     "ten messages all at ~15:27" screenshot). jitteredHold() spreads them.
//  2. CONCURRENCY - serverless has no locks; concurrent drain callers all
//     read the same pacing state and pass together. claimSendSlots() makes
//     the send decision atomic via wa_send_claims primary-key conflicts.

/** A hold timestamp with a per-row random spread - never a shared instant. */
export function jitteredHold(
  nowMs: number,
  baseMinutes: number,
  spreadMinutes: number,
  rand: () => number = Math.random
): string {
  return new Date(nowMs + (baseMinutes + rand() * spreadMinutes) * 60_000).toISOString();
}

/**
 * Cumulative stagger offsets for a batch of size `count`: item 0 is
 * immediate (offset 0), every later item lands 45-75s after the previous
 * one. Durable by design - the offsets become wa_outbox.not_before rows, so
 * they survive restarts, refreshes and redeploys.
 */
export function staggerOffsets(count: number, rand: () => number = Math.random): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) acc += (45 + rand() * 30) * 1000;
    out.push(Math.round(acc));
  }
  return out;
}

/**
 * Cap-AWARE stagger offsets. The first `hourCap` items are spaced ~minGap apart
 * (they fit inside the sender's hourly send budget and go out promptly); every
 * subsequent group of `hourCap` items jumps to the NEXT 1-hour window. So the
 * not_before stamps are the REAL times the anti-ban drain will honor - the
 * queued panel shows the honest schedule from the start, instead of an
 * optimistic "any minute" that silently jumps an hour when the drain hits the
 * cap and re-stamps the overflow. Item 0 is always immediate.
 */
export function cappedStaggerOffsets(
  count: number,
  hourCap: number,
  minGapSec = 90,
  rand: () => number = Math.random
): number[] {
  const cap = Math.max(1, Math.floor(hourCap));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const hour = Math.floor(i / cap);
    const within = i % cap;
    // Push each new hour-group a min-gap PAST the 3600s boundary so the previous
    // group's oldest send has aged out of the drain's inclusive rolling-hour
    // window (>= now-3600000) before this item is due - otherwise the boundary
    // item still trips the cap and gets re-stamped (the jump returns).
    const hourBase = hour === 0 ? 0 : hour * 3600_000 + Math.round((minGapSec + 30) * 1000);
    const inWindow = within === 0 ? 0 : within * (minGapSec + rand() * 30) * 1000;
    out.push(Math.round(hourBase + inWindow));
  }
  return out;
}

/** The min-gap bucket a timestamp falls into (bucket size = the HARD floor). */
export function gapBucket(nowMs: number, gapSeconds: number): number {
  const size = Math.max(1, gapSeconds) * 1000;
  return Math.floor(nowMs / size);
}

/** Stable short hash of a message body for idempotency slot keys. */
export function messageSlotKey(toDigits: string, text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
  return `msg:${digitsOnly(toDigits)}:${createHash("sha256")
    .update(norm)
    .digest("hex")
    .slice(0, 16)}`;
}

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; kind: "pacing" | "duplicate" | "error" };

/**
 * Atomically claim the right to SEND now.
 *
 * - "msg" slot: one delivery per unique (recipient, body) - two concurrent
 *   invocations carrying the same message cannot both send. Claimed BEFORE
 *   the network send (the old dedup row was written after, so concurrent
 *   duplicates both passed).
 * - "gap" slot (auto sends only): one send per min-gap bucket per sender -
 *   serializes the 5+ concurrent drain callers. Straddle-proof: winning the
 *   current bucket also requires the PREVIOUS bucket to be free or older
 *   than the gap, so two sends can never land min-gap-epsilon apart across
 *   a bucket boundary.
 *
 * Fail CLOSED: an unknown claim state ("error") refuses the send - the
 * caller re-queues. A missing wa_send_claims table (schema not migrated)
 * degrades to "ok" - exactly today's behavior until the owner runs the DDL.
 */
export async function claimSendSlots(opts: {
  senderKey: string;
  toDigits: string;
  text: string;
  auto: boolean;
  gapSeconds: number;
  nowMs?: number;
}): Promise<ClaimOutcome> {
  const now = opts.nowMs ?? Date.now();

  // Idempotency first - it applies to every send, human or agent.
  const msgSlot = messageSlotKey(opts.toDigits, opts.text);
  const msg = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: msgSlot,
  });
  if (msg === "lost") return { ok: false, kind: "duplicate" };
  if (msg === "error") {
    // Missing table = pre-migration: behave exactly as before the feature.
    const probe = await sbSelectStrict("wa_send_claims", "select=slot_key&limit=1");
    if ("error" in probe && probe.error === "missing") return { ok: true };
    return { ok: false, kind: "error" };
  }

  if (!opts.auto) return { ok: true };

  const bucket = gapBucket(now, opts.gapSeconds);
  const slotFor = (b: number) => `gap:${opts.gapSeconds}:${b}`;
  const releaseOwn = async (slots: string[]) => {
    for (const s of slots) {
      await sbDelete(
        "wa_send_claims",
        `sender_key=eq.${encodeURIComponent(opts.senderKey)}&slot_key=eq.${encodeURIComponent(s)}`
      ).catch(() => {});
    }
  };

  const cur = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: slotFor(bucket),
  });
  if (cur === "lost") {
    await releaseOwn([msgSlot]); // let the queued retry re-claim the message
    return { ok: false, kind: "pacing" };
  }
  if (cur === "error") {
    await releaseOwn([msgSlot]);
    return { ok: false, kind: "error" };
  }

  // Boundary straddle check: if the PREVIOUS bucket was claimed less than a
  // full gap ago, this send would land too close to the previous one.
  const prev = await sbInsertClaim("wa_send_claims", {
    sender_key: opts.senderKey,
    slot_key: slotFor(bucket - 1),
  });
  if (prev === "lost") {
    const row = await sbSelectStrict<{ created_at: string }>(
      "wa_send_claims",
      `select=created_at&sender_key=eq.${encodeURIComponent(
        opts.senderKey
      )}&slot_key=eq.${encodeURIComponent(slotFor(bucket - 1))}&limit=1`
    );
    const prevAt = "rows" in row ? Date.parse(row.rows[0]?.created_at ?? "") : NaN;
    if (Number.isFinite(prevAt) && now - prevAt < opts.gapSeconds * 1000) {
      await releaseOwn([msgSlot, slotFor(bucket)]);
      return { ok: false, kind: "pacing" };
    }
  }
  // prev === "error" is tolerable: the current-bucket claim already
  // serializes same-window senders; the straddle residue is accepted over
  // failing a legitimate send on a flaky secondary check.
  return { ok: true };
}

/**
 * A send that FAILED after winning its claims must release the message slot,
 * or its own retry would be dropped as a "duplicate" of itself. The gap slot
 * is deliberately kept - a failed network call still consumed the pacing
 * window (the retry re-queues beyond it anyway).
 */
export async function releaseMessageClaim(
  senderKey: string,
  toDigits: string,
  text: string
): Promise<void> {
  await sbDelete(
    "wa_send_claims",
    `sender_key=eq.${encodeURIComponent(senderKey)}&slot_key=eq.${encodeURIComponent(
      messageSlotKey(toDigits, text)
    )}`
  ).catch(() => {});
}

/** Throttled GC (call from the drain tail). Two horizons by slot type. */
export async function gcSendClaims(): Promise<void> {
  // Every NON-idempotency claim (gap: pacing, chain: tick self-chain lock,
  // game: score rate-limit, and any future prefix) only guards a short window -
  // clear after 2h. `not.like.msg:*` restores the pre-split guarantee that the
  // table cannot grow unbounded (the earlier gap:*-only delete leaked chain:
  // and game: rows forever - ~720-2880 chain rows/day on an active cron).
  await sbDelete(
    "wa_send_claims",
    `slot_key=not.like.msg:*&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 2 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
  // msg (idempotency) claims must OUTLIVE the longest possible outbox hold. The
  // daily cap parks a row at oldest+24h, business-hours-clamped (up to ~40h
  // out), and a landed-but-timed-out queue() insert can re-park as a belt
  // duplicate; keeping the twin's msg claim ~72h means that duplicate is still
  // refused at send time (claimSendSlots -> 409 -> skipped) instead of
  // double-sending the same message ~a day apart (a ban signal).
  await sbDelete(
    "wa_send_claims",
    `slot_key=like.msg:*&created_at=lt.${encodeURIComponent(
      new Date(Date.now() - 72 * 3600_000).toISOString()
    )}`
  ).catch(() => {});
}
