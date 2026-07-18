// Classify a failed WhatsApp send. A RECIPIENT failure (the number is not on
// WhatsApp / invalid / blocked) is the recipient's fault and counts toward the
// give-up cap. Everything else is treated as a TRANSIENT infra failure (the
// Evolution host waking/restarting/timed-out, a 5xx, a reconnect, or an unknown/
// empty error from a dead host) - it must NOT burn the retry cap or creep the
// ETA, so a batch resumes the moment the host recovers instead of stalling.

export function isRecipientSendFailure(error?: string | null): boolean {
  return /not.*whatsapp|invalid|exist|blocked|forbidden|no-?phone/i.test(String(error ?? ""));
}

export function isTransientSendFailure(error?: string | null): boolean {
  return !isRecipientSendFailure(error);
}

// A TRANSIENT failure retries fast without burning the attempt cap, so a batch
// resumes the moment the host recovers. But the total lifetime is bounded: a
// PERMANENTLY dead host (or a stale days-old RFQ) must not loop in the outbox
// forever, invisibly re-probing a dead host every ~minute. Age lives in meta
// (each re-queue is a fresh row, so created_at would reset).
export const TRANSIENT_MAX_LIFETIME_MS = 24 * 3600_000;
export const TRANSIENT_MAX_ATTEMPTS = 60;

// A RECIPIENT failure (not on WhatsApp / invalid / blocked) is terminal after a
// few backoff retries - the number is very unlikely to become reachable.
export const RECIPIENT_MAX_ATTEMPTS = 5;

export type RetryDecision =
  | { drop: true }
  | { drop: false; attempts: number; delayMs: number };

// Decide what to do with a TRANSIENT send failure. `firstQueuedAt` is the ms
// timestamp the row was FIRST parked (carried in meta across re-queues so it
// survives the fresh-row reset); `priorAttempts` is meta.transientAttempts.
// Returns either drop (give up - dead host / stale) or a fast re-queue whose
// delay never burns the recipient cap.
export function transientRetryDecision(
  firstQueuedAt: number,
  priorAttempts: number,
  now: number,
  jitter = 0,
): RetryDecision {
  const attempts = priorAttempts + 1;
  if (now - firstQueuedAt > TRANSIENT_MAX_LIFETIME_MS || attempts > TRANSIENT_MAX_ATTEMPTS) {
    return { drop: true };
  }
  // 45-120s: fast enough to resume promptly, jittered so a stalled batch does
  // not re-converge onto one timestamp.
  const delayMs = (45 + Math.max(0, Math.min(1, jitter)) * 75) * 1000;
  return { drop: false, attempts, delayMs };
}

// Decide what to do with a RECIPIENT-level send failure. Backoff creeps but is
// capped so it never pushes past ~20 min even on the last attempt; after
// RECIPIENT_MAX_ATTEMPTS the send is dropped.
export function recipientRetryDecision(priorAttempts: number): RetryDecision {
  const attempts = priorAttempts + 1;
  if (attempts > RECIPIENT_MAX_ATTEMPTS) return { drop: true };
  const delayMs = Math.min(attempts * 4, 20) * 60_000;
  return { drop: false, attempts, delayMs };
}
