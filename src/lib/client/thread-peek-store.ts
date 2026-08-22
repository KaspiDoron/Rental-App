"use client";

// ONE POLL FOR EVERY CARD'S CONVERSATION PEEK.
//
// `ThreadPeek` owned its own `setInterval` and its own fetch, which is the
// obvious way to write it and the wrong one: the component is mounted once per
// engaged shop, so the poll count scaled with the board. Twenty shops meant
// twenty timers and twenty requests every ten seconds, each one waking the
// radio, each one costing a server round trip and two or three database reads.
// On a phone that is the difference between a list that scrolls and one that
// stutters.
//
// This store inverts it. Cards SUBSCRIBE; one timer, one request, one payload
// fans out to whoever is listening. The request cost is now flat in the number
// of shops instead of linear, and a card that mounts mid-cycle gets its data
// from a coalesced immediate tick rather than starting a timer of its own.
//
// It is deliberately a module singleton rather than a context: the peek is the
// same data for every consumer, it must survive a card unmounting and
// remounting as the virtualizer windows the list, and there is exactly one
// server truth behind it.

import type { Peek, PeekMsg } from "@/lib/thread/peek-batch";

export type { Peek, PeekMsg };

/** Matches the old per-card cadence - the peek is a preview, not a transcript. */
// 30s, not 10s. Each tick is a two-query batch over the message table, and at
// 50 concurrent boards a 10-second cadence was a third of the app's entire
// Supabase egress for a panel that shows a one-line preview. A shop reply
// still lands on the CARD within seconds via the replies poll; this is only
// how fast the peek line under it catches up.
export const PEEK_POLL_MS = 30_000;

/**
 * How long to wait before the first request after a subscription arrives.
 *
 * Twenty cards mount within the same frame. Without this, each one would fire
 * its own immediate tick and we would have reproduced the N+1 we just removed,
 * only faster. One short delay collapses the whole mount storm into a single
 * request that already knows about every card.
 */
const COALESCE_MS = 60;

type Listener = (peek: Peek) => void;

const subscribers = new Map<string, Set<Listener>>();
/** The newest peek per shop, so a remounting card paints before the next tick. */
const cache = new Map<string, Peek>();

let sessionEpoch = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let coalesce: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

/**
 * Watch one shop's peek. Returns an unsubscribe.
 *
 * `epoch` is the search-session boundary: only messages from the current hunt
 * may be shown, never a previous session's conversation with the same shop. It
 * only ever moves FORWARD, so a stale card cannot widen the window for
 * everyone else.
 */
export function subscribeThreadPeek(
  vendorId: string,
  epoch: number | undefined,
  onPeek: Listener
): () => void {
  if (!vendorId) return () => {};

  let set = subscribers.get(vendorId);
  if (!set) {
    set = new Set();
    subscribers.set(vendorId, set);
  }
  set.add(onPeek);

  if (epoch && epoch > sessionEpoch) {
    // A NEW SEARCH invalidates every cached peek: the same shop's previous
    // conversation must never bleed into this hunt's card.
    if (sessionEpoch) cache.clear();
    sessionEpoch = epoch;
  }

  const cached = cache.get(vendorId);
  if (cached) onPeek(cached);

  start();
  scheduleSoon();

  return () => {
    const live = subscribers.get(vendorId);
    if (!live) return;
    live.delete(onPeek);
    if (live.size === 0) subscribers.delete(vendorId);
    if (subscribers.size === 0) stop();
  };
}

function start() {
  if (timer) return;
  timer = setInterval(() => void tick(), PEEK_POLL_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (coalesce) clearTimeout(coalesce);
  coalesce = null;
  inFlight?.abort();
  inFlight = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

function onVisibility() {
  // The interval kept running while the tab was hidden and every tick returned
  // early, so coming back meant waiting out the remainder of a ten-second
  // window looking at stale text. Refresh on the way in instead.
  if (typeof document !== "undefined" && !document.hidden) scheduleSoon();
}

function scheduleSoon() {
  if (coalesce) return;
  coalesce = setTimeout(() => {
    coalesce = null;
    void tick();
  }, COALESCE_MS);
}

async function tick() {
  if (typeof document !== "undefined" && document.hidden) return;
  const ids = [...subscribers.keys()];
  if (ids.length === 0) return;
  // OVERLAP GUARD. A slow response on a bad connection used to be overtaken by
  // the next interval, and the two could land out of order - the older answer
  // painting over the newer one. One request in the air at a time; the interval
  // that finds one already running simply skips.
  if (inFlight) return;

  const ac = new AbortController();
  inFlight = ac;
  try {
    const url =
      `/api/thread?vendorIds=${encodeURIComponent(ids.join(","))}` +
      (sessionEpoch ? `&since=${sessionEpoch}` : "");
    const res = await fetch(url, { cache: "no-store", signal: ac.signal });
    if (!res.ok) return;
    const data = (await res.json()) as { peeks?: Record<string, Peek> };
    const peeks = data?.peeks;
    if (!peeks || typeof peeks !== "object") return;
    for (const [vendorId, peek] of Object.entries(peeks)) {
      if (!peek) continue;
      cache.set(vendorId, peek);
      const listeners = subscribers.get(vendorId);
      if (!listeners) continue;
      for (const listener of listeners) listener(peek);
    }
  } catch {
    /* transient - the next tick retries */
  } finally {
    if (inFlight === ac) inFlight = null;
  }
}

/** Test seam: drop every subscriber, timer and cached peek. */
export function __resetThreadPeekStore() {
  subscribers.clear();
  cache.clear();
  sessionEpoch = 0;
  stop();
}
