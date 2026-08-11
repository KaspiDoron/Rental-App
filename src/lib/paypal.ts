// PayPal Subscriptions billing via the REST API - no SDK dependency.
//
// Chosen because PayPal has NO merchant-approval gate (unlike a Merchant-of-
// Record such as Lemon Squeezy/Paddle, whose review can decline a store), is
// free to set up ($0/month), and fully supports Israeli residents + payouts to
// Israeli bank accounts. It is NOT a Merchant of Record, so it does not remit
// VAT on your behalf.
//
// Flow: create a subscription server-side against a pre-made PayPal Billing Plan
// -> redirect the buyer to the returned approval URL -> PayPal fires a SIGNED
// webhook we verify + use to grant the plan (the success-redirect never grants).
//
// Config (Admin -> Keys, or env): PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET,
// PAYPAL_PLAN_PRO, PAYPAL_PLAN_ULTRA, PAYPAL_WEBHOOK_ID, PAYPAL_ENV
// ("live" | "sandbox", default "live").

import "server-only";
import { getConfig } from "./runtime-config";

/** PayPal REST base for the configured environment. */
async function paypalBase(): Promise<string> {
  const env = ((await getConfig("PAYPAL_ENV")) ?? "live").trim().toLowerCase();
  return env === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
}

export async function paypalConfigured(): Promise<boolean> {
  const [id, secret] = await Promise.all([
    getConfig("PAYPAL_CLIENT_ID"),
    getConfig("PAYPAL_CLIENT_SECRET"),
  ]);
  return Boolean(id && secret);
}

// Short-lived access-token cache (PayPal tokens live ~9h; refresh at 8h).
let tokenCache: { token: string; exp: number } | null = null;

/** OAuth2 client-credentials access token (cached). Returns null if unconfigured. */
async function paypalToken(): Promise<string | null> {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token;
  const [id, secret] = await Promise.all([
    getConfig("PAYPAL_CLIENT_ID"),
    getConfig("PAYPAL_CLIENT_SECRET"),
  ]);
  if (!id || !secret) return null;
  const base = await paypalBase();
  const basic = Buffer.from(`${id.trim()}:${secret.trim()}`).toString("base64");
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return null;
  tokenCache = {
    token: data.access_token,
    exp: Date.now() + Math.min(Number(data.expires_in) || 3600, 28800) * 1000,
  };
  return tokenCache.token;
}

/** The PayPal Billing Plan id configured for a WheelDeal tier. */
async function planIdFor(planId: string): Promise<string | undefined> {
  if (planId === "pro") return getConfig("PAYPAL_PLAN_PRO");
  if (planId === "ultra") return getConfig("PAYPAL_PLAN_ULTRA");
  return undefined;
}

/** Create a subscription and return its approval URL for the buyer to complete. */
export async function createPaypalCheckout(
  planId: string,
  origin: string,
  email?: string
): Promise<{ url?: string; error?: string; configured: boolean }> {
  if (!(await paypalConfigured())) {
    return { configured: false, error: "PayPal is not configured yet." };
  }
  const paypalPlan = await planIdFor(planId);
  if (!paypalPlan) {
    return {
      configured: true,
      error: `No PayPal plan is set for the ${planId} tier (owner: add PAYPAL_PLAN_${planId.toUpperCase()} in Admin -> Keys).`,
    };
  }
  const token = await paypalToken();
  if (!token) return { configured: false, error: "PayPal credentials rejected." };

  const base = await paypalBase();
  try {
    const res = await fetch(`${base}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // A stable-ish idempotency key avoids duplicate subs on a double-click.
        "PayPal-Request-Id": `wd-${planId}-${email ?? "anon"}`,
      },
      body: JSON.stringify({
        plan_id: String(paypalPlan).trim(),
        // Carried through to every webhook event so the SIGNED webhook can grant
        // the plan server-side (the success-redirect must never be trusted).
        custom_id: `${(email ?? "").toLowerCase()}|${planId}`,
        subscriber: email ? { email_address: email } : undefined,
        application_context: {
          brand_name: "WheelDeal",
          locale: "en-US",
          user_action: "SUBSCRIBE_NOW",
          shipping_preference: "NO_SHIPPING",
          payment_method: {
            payer_selected: "PAYPAL",
            payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
          },
          return_url: `${origin}/?billing=success&plan=${planId}`,
          cancel_url: `${origin}/?billing=cancelled`,
        },
      }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        data?.details?.[0]?.description ?? data?.message ?? `PayPal ${res.status}`;
      return { configured: true, error: detail };
    }
    const links: { rel?: string; href?: string }[] = Array.isArray(data.links) ? data.links : [];
    const approve = links.find((l) => l.rel === "approve")?.href;
    if (!approve) return { configured: true, error: "PayPal returned no approval link." };
    return { configured: true, url: approve };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : "network error" };
  }
}

/**
 * Verify a PayPal webhook via the verify-webhook-signature API (PayPal signs
 * with a rotating cert, so verification is a server-to-server call keyed on the
 * PAYPAL_WEBHOOK_ID rather than a local HMAC). Returns false when unconfigured.
 */
export async function verifyPaypalWebhook(
  headers: Headers,
  rawBody: string
): Promise<boolean> {
  const webhookId = await getConfig("PAYPAL_WEBHOOK_ID");
  if (!webhookId) return false;
  const token = await paypalToken();
  if (!token) return false;

  const h = (name: string) => headers.get(name) ?? "";
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const base = await paypalBase();
  try {
    const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: String(webhookId).trim(),
        webhook_event: event,
      }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return data?.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// SUBSCRIPTION VERIFICATION
//
// The browser hands back a subscription id after PayPal's own approval flow.
// That id is a CLAIM, not a fact: it arrives over a channel the traveller
// controls, and granting a paid tier on it directly would let anyone type one
// in. So the only thing the client's id is used for is to ASK PayPal - with the
// secret, server-side - what that subscription actually is: whose plan, what
// state, and which tier it corresponds to.
//
// Everything below this line runs on the server only. The secret never leaves it.
// ---------------------------------------------------------------------------

export interface PaypalSubscription {
  id: string;
  status: string;
  planId: string | null;
  subscriberEmail: string | null;
  nextBillingAt: string | null;
}

/** States in which a subscription genuinely entitles someone to their tier. */
const ENTITLING = new Set(["ACTIVE", "APPROVED"]);

export function subscriptionEntitles(status: string | null | undefined): boolean {
  return ENTITLING.has(String(status ?? "").toUpperCase());
}

/**
 * Read a subscription straight from PayPal. Returns null when PayPal is
 * unconfigured or the id is not one of ours - never a partially trusted object.
 */
export async function fetchPaypalSubscription(
  subscriptionId: string
): Promise<PaypalSubscription | null> {
  const id = String(subscriptionId ?? "").trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const token = await paypalToken();
  if (!token) return null;
  const base = await paypalBase();
  const res = await fetch(`${base}/v1/billing/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    id?: string;
    status?: string;
    plan_id?: string;
    subscriber?: { email_address?: string };
    billing_info?: { next_billing_time?: string };
  } | null;
  if (!d?.id) return null;
  return {
    id: d.id,
    status: String(d.status ?? ""),
    planId: d.plan_id ?? null,
    subscriberEmail: d.subscriber?.email_address ?? null,
    nextBillingAt: d.billing_info?.next_billing_time ?? null,
  };
}

/**
 * Cancel a subscription at PayPal. Returns true only when PayPal confirms it.
 *
 * USED WHEN A PLAN SWITCH SUPERSEDES AN OLD SUBSCRIPTION, and the honesty of
 * the return value is the whole point: a switch that silently failed to cancel
 * leaves the traveller paying for two plans at once, and only PayPal knows
 * whether it worked.
 */
export async function cancelPaypalSubscription(
  subscriptionId: string,
  reason: string
): Promise<boolean> {
  const id = String(subscriptionId ?? "").trim();
  if (!id || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const token = await paypalToken();
  if (!token) return false;
  const base = await paypalBase();
  try {
    const res = await fetch(`${base}/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.slice(0, 127) }),
      cache: "no-store",
    });
    // 204 is the success shape. 422 usually means it is already cancelled,
    // which is the state we wanted - treat it as done rather than as a failure
    // that would make a retry loop forever.
    if (res.status === 204) return true;
    if (res.status === 422) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Which WheelDeal tier a PayPal plan id corresponds to.
 *
 * Resolved from the CONFIGURED plan ids rather than from anything the client
 * said, so a valid subscription to the Pro plan can never be redeemed as Ultra.
 */
export async function tierForPaypalPlan(planId: string | null): Promise<"pro" | "ultra" | null> {
  if (!planId) return null;
  const { PAYPAL_PLANS } = await import("./paypal-plans");
  const [pro, ultra] = await Promise.all([
    getConfig(PAYPAL_PLANS.pro.configKey),
    getConfig(PAYPAL_PLANS.ultra.configKey),
  ]);
  const norm = (v: string | undefined | null) => (v ?? "").trim();
  if (planId === norm(pro) || planId === PAYPAL_PLANS.pro.fallbackPlanId) return "pro";
  if (planId === norm(ultra) || planId === PAYPAL_PLANS.ultra.fallbackPlanId) return "ultra";
  return null;
}
