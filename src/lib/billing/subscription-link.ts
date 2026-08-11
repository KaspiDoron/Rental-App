import "server-only";
import { sbSelect } from "@/lib/runtime-config";

// A SUBSCRIPTION HAS TO POINT BACK AT A TRAVELLER.
//
// PayPal's lifecycle webhooks (cancelled, expired, suspended) carry a
// subscription id and PayPal's own subscriber record - they do NOT carry our
// account. The webhook was reading `resource.custom_id` for an "email|plan"
// pair, but the subscribe button creates subscriptions with `plan_id` alone, so
// custom_id is empty on every subscription this app has ever created. Result: a
// traveller who cancelled kept their tier forever, because the webhook had a
// subscription it could not attribute to anyone.
//
// The fix is not to start trusting a client-supplied custom_id. We already
// wrote a VERIFIED record at activation time - server side, after asking PayPal
// what the subscription really was - and that record names the signed-in
// traveller. So the link is derived from our own evidence, and a webhook can
// always answer "whose is this?".

/** The audit row written by /api/subscriptions/paypal-success. */
export const ACTIVATION_KIND = "subscription-activated";

interface ActivationRow {
  user_email?: string | null;
  detail?: string | null;
}

/**
 * The account a PayPal subscription belongs to, or null if we have no verified
 * record of it. Null is a real answer: it means this subscription was not
 * activated through us, and nothing should be changed on its say-so.
 */
export async function subscriberFor(subscriptionId: string): Promise<string | null> {
  const id = subscriptionId.trim();
  if (!id) return null;

  const rows = await sbSelect<ActivationRow>(
    "agent_events",
    `select=user_email,detail&kind=eq.${ACTIVATION_KIND}` +
      `&detail=ilike.${encodeURIComponent(`*${id}*`)}` +
      `&order=created_at.desc&limit=5`
  ).catch(() => [] as ActivationRow[]);

  for (const row of rows) {
    // `ilike` is a substring match, so confirm the id is really THIS row's
    // subscription and not, say, a prefix of a longer one recorded elsewhere.
    if (!matchesSubscription(row.detail, id)) continue;
    const email = (row.user_email ?? "").trim().toLowerCase();
    if (email) return email;
  }
  return null;
}

function matchesSubscription(detail: string | null | undefined, id: string): boolean {
  if (!detail) return false;
  try {
    const parsed = JSON.parse(detail) as { subscriptionId?: unknown };
    return String(parsed.subscriptionId ?? "") === id;
  } catch {
    return false;
  }
}

/**
 * Every subscription id we have ever activated for this account, newest first.
 *
 * Derived from the same append-only activation trail `subscriberFor` reads, so
 * there is no mutable "current subscription" column to fall out of step with
 * reality when a webhook is lost.
 */
export async function activationsFor(email: string): Promise<string[]> {
  const key = String(email ?? "").trim().toLowerCase();
  if (!key) return [];
  const rows = await sbSelect<ActivationRow>(
    "agent_events",
    `select=user_email,detail&kind=eq.${ACTIVATION_KIND}` +
      `&user_email=eq.${encodeURIComponent(key)}` +
      `&order=created_at.desc&limit=20`
  ).catch(() => [] as ActivationRow[]);
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const id = String(
        (JSON.parse(row.detail ?? "null") as { subscriptionId?: unknown })?.subscriptionId ?? ""
      ).trim();
      if (id && !ids.includes(id)) ids.push(id);
    } catch {
      /* an unparseable row is not a subscription */
    }
  }
  return ids;
}

/** Recorded when a plan switch cancels the subscription it replaced. */
export const SUPERSEDED_KIND = "subscription-superseded";

// ---- Suspension state, derived from the same append-only evidence ------------
//
// A suspension needs a START so the grace window in ./suspension can be
// measured. Rather than a mutable column that a lost webhook would leave wrong
// forever, the state is DERIVED from the event trail: whichever of "suspended"
// / "resumed" we saw most recently for this subscription is the current truth.
// Append-only, self-correcting, and it survives a webhook arriving out of order
// because the newest event still wins.

export const SUSPENDED_KIND = "subscription-suspended";
export const RESUMED_KIND = "subscription-resumed";

/**
 * When this subscription was first seen suspended, or null if it is not
 * currently suspended (never was, or has since resumed).
 */
export async function suspendedSinceFor(subscriptionId: string): Promise<number | null> {
  const id = subscriptionId.trim();
  if (!id) return null;
  const rows = await sbSelect<ActivationRow & { kind?: string; created_at?: string }>(
    "agent_events",
    `select=kind,detail,created_at&kind=in.(${SUSPENDED_KIND},${RESUMED_KIND})` +
      `&detail=ilike.${encodeURIComponent(`*${id}*`)}` +
      `&order=created_at.desc&limit=10`
  ).catch(() => []);

  for (const row of rows) {
    if (!matchesSubscription(row.detail, id)) continue;
    // The newest matching event decides. A resume ends the window; a suspension
    // starts one.
    if (row.kind === RESUMED_KIND) return null;
    if (row.kind === SUSPENDED_KIND) return Date.parse(row.created_at ?? "") || null;
  }
  return null;
}

/** Record a suspension / resumption against a subscription. Best-effort. */
export async function markSubscriptionState(
  kind: typeof SUSPENDED_KIND | typeof RESUMED_KIND,
  input: { email: string; subscriptionId: string }
): Promise<void> {
  const { sbInsert } = await import("@/lib/runtime-config");
  await sbInsert("agent_events", [
    {
      kind,
      user_email: input.email,
      vendor_id: "",
      vendor_name: "",
      detail: JSON.stringify({ subscriptionId: input.subscriptionId }),
    },
  ]).catch(() => {});
}
