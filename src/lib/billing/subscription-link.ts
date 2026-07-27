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
