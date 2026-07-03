// Lemon Squeezy billing - the Merchant of Record path for countries where
// Stripe does not onboard individuals (e.g. Israel). Lemon Squeezy handles
// taxes/compliance and pays out via PayPal or bank wire. No monthly fee.
//
// Config (Admin -> Keys): LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID,
// LEMONSQUEEZY_VARIANT_PRO, LEMONSQUEEZY_VARIANT_ULTRA,
// LEMONSQUEEZY_WEBHOOK_SECRET.

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig } from "./runtime-config";

export async function lemonConfigured(): Promise<boolean> {
  const [key, store] = await Promise.all([
    getConfig("LEMONSQUEEZY_API_KEY"),
    getConfig("LEMONSQUEEZY_STORE_ID"),
  ]);
  return Boolean(key && store);
}

async function variantFor(planId: string): Promise<string | undefined> {
  if (planId === "pro") return getConfig("LEMONSQUEEZY_VARIANT_PRO");
  if (planId === "ultra") return getConfig("LEMONSQUEEZY_VARIANT_ULTRA");
  return undefined;
}

/** Create a hosted checkout link for a plan. */
export async function createLemonCheckout(
  planId: string,
  origin: string,
  email?: string
): Promise<{ url?: string; error?: string; configured: boolean }> {
  const [key, store] = await Promise.all([
    getConfig("LEMONSQUEEZY_API_KEY"),
    getConfig("LEMONSQUEEZY_STORE_ID"),
  ]);
  if (!key || !store) return { configured: false, error: "Lemon Squeezy is not configured yet." };

  const variant = await variantFor(planId);
  if (!variant) {
    return {
      configured: true,
      error: `No Lemon Squeezy variant is set for the ${planId} plan (owner: add LEMONSQUEEZY_VARIANT_${planId.toUpperCase()} in Admin -> Keys).`,
    };
  }

  try {
    const res = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${key.trim()}`,
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              email: email ?? undefined,
              custom: { plan: planId, email: email ?? "" },
            },
            product_options: {
              redirect_url: `${origin}/?billing=success&plan=${planId}`,
            },
          },
          relationships: {
            store: { data: { type: "stores", id: String(store).trim() } },
            variant: { data: { type: "variants", id: String(variant).trim() } },
          },
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        data?.errors?.[0]?.detail ?? data?.errors?.[0]?.title ?? `Lemon Squeezy ${res.status}`;
      return { configured: true, error: detail };
    }
    return { configured: true, url: data?.data?.attributes?.url };
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}

/** Verify the X-Signature header of a Lemon Squeezy webhook (HMAC-SHA256). */
export async function verifyLemonSignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const secret = await getConfig("LEMONSQUEEZY_WEBHOOK_SECRET");
  if (!secret || !signature) return false;
  const digest = createHmac("sha256", secret.trim()).update(rawBody).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}
