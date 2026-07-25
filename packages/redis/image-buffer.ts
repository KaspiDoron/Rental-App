// @wheeldeal/redis/image-buffer - multi-image-per-turn coalescing (Module 4.1).
//
// WhatsApp delivers every photo of an album as its OWN messages.upsert webhook,
// so a shop that sends a 3-photo price board triggers three separate vision
// turns - three replies, three OCR passes, and each pass sees only one third of
// the board. This buffer collapses a burst of images from the SAME
// (receiver, shop) into ONE vision turn that reads them together.
//
// Mechanism (race-safe, worker-path only - REDIS is always present there):
//   - A SETNX "window claim" imgwin:<receiver>:<from> (EX = window seconds)
//     elects exactly ONE image as the burst LEADER. The leader's caller
//     schedules a SINGLE delayed vision flow; every sibling within the window
//     just appends its frame and schedules nothing.
//   - Frames accumulate in a Redis list imgbuf:<leaderWaId> (short TTL). When
//     the leader's delayed flow child runs, it DRAINS the whole list and hands
//     every frame to the multi-image extractor in one pass.
//
// A SETNX leader (not a wall-clock time bucket) avoids the boundary bug where
// two photos ~1s apart straddle a bucket edge and split into two flows.
//
// FAIL-SAFE: any Redis error degrades to first:true with the single incoming
// frame - i.e. exactly the pre-coalescing behavior (one flow per image). A
// hiccup never drops a photo; at worst it forfeits the batching for that burst.

import { redis } from "./index";

/** Default coalesce window. Album frames land within ~1-2s; 6s catches the
 * burst while keeping the added latency on a lone photo modest + honest. */
export const IMAGE_WINDOW_SECONDS = 6;
/** Buffered frames self-expire well after the window so a crashed/retried child
 * can still re-read them, but a later burst never inherits stale frames. */
const IMAGE_BUFFER_TTL_SECONDS = 120;

/** Pure key builders (unit-tested). */
export function imageWindowKey(receiver: string, from: string): string {
  return `imgwin:${receiver}:${from}`;
}
export function imageBufferKey(leaderWaId: string): string {
  return `imgbuf:${leaderWaId}`;
}

export interface ImageWindowStart {
  /** True when THIS frame opened the window - the caller schedules the flow. */
  first: boolean;
  /** The burst leader's waMessageId - keys the buffer + the flow jobIds. */
  leaderWaId: string;
}

/**
 * Register an inbound image frame in its (receiver, from) burst window and
 * report whether it is the LEADER (the one that should schedule the flow).
 * Always appends the frame to the leader's buffer. Never throws.
 */
export async function beginImageWindow(input: {
  receiver: string;
  from: string;
  waMessageId: string;
  frame: unknown;
  windowSeconds?: number;
}): Promise<ImageWindowStart> {
  const { receiver, from, waMessageId, frame } = input;
  const windowSeconds = input.windowSeconds ?? IMAGE_WINDOW_SECONDS;
  try {
    const r = redis();
    const winKey = imageWindowKey(receiver, from);
    // Elect the leader: only the first SETNX within the window wins.
    const won = await r.set(winKey, waMessageId, "EX", windowSeconds, "NX");
    const leaderWaId = won === "OK" ? waMessageId : (await r.get(winKey)) || waMessageId;
    const bufKey = imageBufferKey(leaderWaId);
    await r.rpush(bufKey, JSON.stringify(frame));
    await r.expire(bufKey, IMAGE_BUFFER_TTL_SECONDS);
    return { first: won === "OK", leaderWaId };
  } catch {
    // Redis unavailable -> behave exactly like the pre-coalescing path: this
    // frame is its own leader and will be processed alone.
    return { first: true, leaderWaId: waMessageId };
  }
}

/**
 * Drain every buffered frame for a burst leader. Returns the frames in arrival
 * order (leader first). Best-effort clears the buffer + window claim so a
 * following burst starts clean. Returns [] on any error (caller falls back to
 * the single frame carried on the job).
 */
export async function drainImageWindow(input: {
  receiver: string;
  from: string;
  leaderWaId: string;
}): Promise<unknown[]> {
  const { receiver, from, leaderWaId } = input;
  try {
    const r = redis();
    const bufKey = imageBufferKey(leaderWaId);
    const raw = await r.lrange(bufKey, 0, -1);
    await r.del(bufKey);
    // Only clear the window claim if it still points at THIS leader (a newer
    // burst may already own it).
    const winKey = imageWindowKey(receiver, from);
    const cur = await r.get(winKey);
    if (cur === leaderWaId) await r.del(winKey);
    const frames: unknown[] = [];
    for (const s of raw) {
      try {
        frames.push(JSON.parse(s));
      } catch {
        /* skip a corrupt frame - the others still extract */
      }
    }
    return frames;
  } catch {
    return [];
  }
}
