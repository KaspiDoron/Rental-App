// A SUSPENSION IS NOT A CANCELLATION.
//
// The webhook treated BILLING.SUBSCRIPTION.SUSPENDED exactly like CANCELLED and
// EXPIRED: instant drop to free. But PayPal suspends a subscription for a
// recoverable payment failure - an expired card, a bank decline, a temporary
// hold - and then RETRIES on its own schedule, sending RE-ACTIVATED when the
// money lands. So a paying traveller whose card was declined on Tuesday lost
// their agents mid-hunt, on a beach, with a live negotiation running, and got
// them back on Thursday with no explanation of either event.
//
// A cancellation is a decision and takes effect at once. A suspension is a
// problem, and a problem gets a window. This is that window, kept pure so the
// policy is testable and stated in exactly one place.

/**
 * How long a suspended subscription keeps its tier.
 *
 * PayPal's default dunning retries run over roughly a week, so the grace has to
 * outlast the retries or it is not a grace at all - it is the same instant
 * downgrade with extra steps. Seven days covers the retry schedule; beyond it,
 * a suspension that has not recovered is a subscription that is not being paid.
 */
export const SUSPENSION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type BillingEffect = "keep" | "downgrade" | "grace";

/**
 * What a lifecycle event should do to the traveller's plan RIGHT NOW.
 *
 * `suspendedSince` is when we first saw this subscription suspended (null on
 * the first suspension event). Passing `now` explicitly keeps this a function of
 * its arguments rather than of the clock.
 */
export function effectForEvent(
  event: string,
  opts: { suspendedSince?: number | null; now: number } = { now: 0 }
): BillingEffect {
  const e = String(event ?? "").toUpperCase();

  // A DECISION, and an ending. Both take effect immediately - the traveller
  // cancelled, or the subscription ran its course.
  if (e === "BILLING.SUBSCRIPTION.CANCELLED" || e === "BILLING.SUBSCRIPTION.EXPIRED") {
    return "downgrade";
  }

  if (e === "BILLING.SUBSCRIPTION.SUSPENDED") {
    const since = opts.suspendedSince ?? null;
    // First sight of the suspension: start the clock, keep the tier.
    if (!since) return "grace";
    return opts.now - since >= SUSPENSION_GRACE_MS ? "downgrade" : "grace";
  }

  return "keep";
}

/** Whether an event should clear a recorded suspension (payment recovered). */
export function clearsSuspension(event: string): boolean {
  const e = String(event ?? "").toUpperCase();
  return (
    e === "BILLING.SUBSCRIPTION.ACTIVATED" ||
    e === "BILLING.SUBSCRIPTION.RE-ACTIVATED" ||
    e === "PAYMENT.SALE.COMPLETED"
  );
}

/** How long is left in the grace window, in whole days (0 when it has run out). */
export function graceDaysLeft(suspendedSince: number | null | undefined, now: number): number {
  if (!suspendedSince) return Math.ceil(SUSPENSION_GRACE_MS / 86_400_000);
  const left = suspendedSince + SUSPENSION_GRACE_MS - now;
  return left <= 0 ? 0 : Math.ceil(left / 86_400_000);
}
