// ONE definition of "is this traveller's WhatsApp linked?", for every client
// surface that asks.
//
// This exists because three surfaces asked the same question three different
// ways and disagreed on screen: the Profile pill sat on "CHECKING..." forever,
// the Find-deals card showed "Link WhatsApp to unlock" - and the connect box
// right next to the pill said "WhatsApp connected". Only one of the three
// (WaConnect) polled and passed `cache: "no-store"`; the other two fetched once
// and treated a slow or failed read as an answer.
//
// The rules that keep them honest:
//
//  1. A FAILED READ IS NOT AN ANSWER. `/api/wa/status` probes the Evolution host
//     and can take many seconds when it is cold. Reporting "not linked" because
//     we could not reach our own API tells a paired user to re-link something
//     that is already working. `reachable:false` is its own outcome.
//  2. NEVER CACHED. `no-store` plus a cache-buster - a stale "false" replayed by
//     the browser is indistinguishable from a real disconnection.
//  3. BOUNDED AND RETRIED. One slow attempt is not a verdict; a few bounded
//     attempts are.

export interface WaStatus {
  /** false = we never got an answer. `connected` is then meaningless. */
  reachable: boolean;
  /** Linked from the traveller's perspective (live socket OR durably paired). */
  connected: boolean;
  /** The socket is live right now (as opposed to paired-and-reconnecting). */
  live?: boolean;
  reconnecting?: boolean;
  /** Evolution is not configured at all - nobody can link. */
  available?: boolean;
  state?: string;
  phase?: string;
}

const ATTEMPT_TIMEOUT_MS = 8_000;
const BACKOFF_MS = [0, 1_200, 3_000];

async function once(pairing: boolean, timeoutMs: number): Promise<WaStatus | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // `drain=0` ALWAYS. This function answers ONE question - is this number
    // linked? - and every caller of it is a UI truth read that aborts at
    // ATTEMPT_TIMEOUT_MS. The endpoint also doubles as an opportunistic outbox
    // worker, and that work is bounded at 8s PER DRAIN, twice, ahead of the
    // response: a ~20s worst case behind an 8s abort, so the answer this
    // function exists to get could not arrive at all while a queue was busy.
    // The drains still run - from the polls that are actually acting as worker
    // ticks (/api/activity, /api/replies) and from the heartbeat, none of which
    // are blocking a person on a lock screen.
    const res = await fetch(
      `/api/wa/status?drain=0&${pairing ? "pairing=1&" : ""}t=${Date.now()}`,
      { cache: "no-store", signal: ctrl.signal }
    );
    if (!res.ok) return null;
    const d = await res.json();
    // A shape we cannot read is not an answer either.
    if (typeof d?.connected !== "boolean") return null;
    return {
      reachable: true,
      connected: d.connected,
      live: d.live,
      reconnecting: d.reconnecting,
      available: d.available,
      state: d.state,
      phase: d.phase,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the server whether WhatsApp is linked, with bounded retries.
 *
 * @param opts.pairing Skip the server's outbox/wakeup drains. Use for polls
 *   during pairing, where there is nothing to drain and latency is what matters.
 * @param opts.attempts How many bounded tries before giving up (default 3).
 */
export async function probeWaStatus(
  opts: { pairing?: boolean; attempts?: number } = {}
): Promise<WaStatus> {
  const attempts = Math.max(1, Math.min(opts.attempts ?? 3, BACKOFF_MS.length));
  for (let i = 0; i < attempts; i++) {
    if (BACKOFF_MS[i]) await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));
    const answer = await once(Boolean(opts.pairing), ATTEMPT_TIMEOUT_MS);
    if (answer) return answer;
  }
  // Unreachable. Callers must NOT render this as "not linked".
  return { reachable: false, connected: false };
}
