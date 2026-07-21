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
