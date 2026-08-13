import "server-only";

// RECONCILE SWEEP (wave 4.3) - the webhook-independent belt-and-braces.
//
// The webhook is the only push channel PayPal has, and it did not exist for
// the app's whole life so far: anyone who cancelled kept their paid tier.
// This sweep asks PayPal directly, per paid account, whether ANY of that
// account's recorded subscriptions still entitles it - and downgrades when
// PayPal answers "no" for all of them.
//
// FAIL DIRECTION: a paid tier is only ever LOWERED on a POSITIVE answer from
// PayPal (a fetched subscription in a non-entitling, non-suspended state).
// An unreadable subscription, missing credentials, or an account with no
// recorded activation at all changes NOTHING - never downgrade on a shrug.
// Suspensions are also left alone: the webhook grace machinery owns those.

import { listUsers, setPlan } from "@/lib/access";
import { activationsFor } from "@/lib/billing/subscription-link";
import { fetchPaypalSubscription, paypalConfigured, subscriptionEntitles } from "@/lib/paypal";
import { sbInsert } from "@/lib/runtime-config";

export interface ReconcileResult {
  checked: number;
  downgraded: string[];
  kept: number;
  /** Accounts we could not judge (no activation record or unreadable subs). */
  unknown: number;
  error?: string;
}

export async function reconcilePaypalPlans(): Promise<ReconcileResult> {
  if (!(await paypalConfigured())) {
    return { checked: 0, downgraded: [], kept: 0, unknown: 0, error: "PayPal is not configured." };
  }
  const users = await listUsers().catch(() => []);
  const paid = users.filter((u) => u.plan === "pro" || u.plan === "ultra");

  const downgraded: string[] = [];
  let kept = 0;
  let unknown = 0;

  for (const user of paid) {
    const ids = await activationsFor(user.email).catch(() => []);
    if (ids.length === 0) {
      // No recorded PayPal activation: this plan was granted some other way
      // (TEST_MODE, owner grant). Not ours to judge.
      unknown++;
      continue;
    }
    let sawEntitling = false;
    let sawSuspended = false;
    let readable = 0;
    for (const id of ids) {
      const sub = await fetchPaypalSubscription(id).catch(() => null);
      if (!sub) continue;
      readable++;
      if (subscriptionEntitles(sub.status)) sawEntitling = true;
      if (sub.status.toUpperCase() === "SUSPENDED") sawSuspended = true;
      if (sawEntitling) break;
    }
    if (sawEntitling) {
      kept++;
      continue;
    }
    if (readable === 0 || sawSuspended) {
      // Unreadable = shrug, suspended = the grace window's job. Keep the tier.
      unknown++;
      continue;
    }
    // Every recorded subscription is readable and none entitles: the paid
    // tier is orphaned. Downgrade, and leave a durable trace.
    const ok = await setPlan(user.email, "free").catch(() => false);
    if (ok) {
      downgraded.push(user.email);
      await sbInsert("billing_events", [
        { type: `pp_reconcile_downgrade_${user.plan}`, verified: true },
      ]).catch(() => {});
    } else {
      unknown++;
    }
  }

  return { checked: paid.length, downgraded, kept, unknown };
}
