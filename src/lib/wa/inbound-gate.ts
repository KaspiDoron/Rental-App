// BOUNDED CONCURRENCY FOR WEBHOOK AI TURNS (owner report 4, scale #7).
//
// With --concurrency 32 one Cloud Run instance can be handed 32 webhooks at
// once, and each inbound turn runs the whole LLM chain (extraction -> engine ->
// validator -> localization). 32 concurrent chains on a 1GB/1-CPU instance is
// how memory spikes and everyone's reply slows together. This gate caps the
// number of heavy turns IN FLIGHT per instance; the rest queue for a slot
// rather than piling on. It is a smoother, not a limiter: nothing is dropped,
// and a waiter that would exceed the caller's patience simply proceeds
// ungated (better a slightly-heavy moment than a lost reply).
//
// In-process by design - it protects THIS instance's RAM/CPU, which is a
// per-instance resource. The full cross-fleet offload is the BullMQ workers
// upgrade path; this is the serverless-path floor.

const MAX_INFLIGHT = 4;
/** A waiter never blocks longer than this before proceeding ungated. */
const MAX_WAIT_MS = 8_000;

let inflight = 0;
const waiters: Array<() => void> = [];

/** Exposed for tests + the KPI card. */
export function inboundInflight(): { inflight: number; queued: number } {
  return { inflight, queued: waiters.length };
}

/** Test hook. */
export function resetInboundGate(): void {
  inflight = 0;
  waiters.length = 0;
}

/**
 * Run `work` with at most MAX_INFLIGHT concurrent heavy turns per instance.
 * Acquires a slot (waiting up to MAX_WAIT_MS), always releases it - and never
 * changes what `work` returns or throws. A gate must never eat a reply.
 */
export async function withInboundSlot<T>(work: () => Promise<T>): Promise<T> {
  const acquired = await acquire();
  try {
    return await work();
  } finally {
    if (acquired) release();
  }
}

async function acquire(): Promise<boolean> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return true;
  }
  // Wait for a slot, but bounded: a reply that waits forever is worse than one
  // heavy moment. If the timer wins, proceed WITHOUT holding a slot (so we do
  // not later release one we never took, and never wedge the counter).
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, MAX_WAIT_MS);
    const grant = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inflight++;
      resolve(true);
    };
    waiters.push(grant);
  });
}

function release(): void {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}
