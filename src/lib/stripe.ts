// Stripe billing (management-only) via the REST API - no SDK dependency.
//
// This is the initial scaffold: real Checkout Sessions are created when
// STRIPE_SECRET_KEY is configured (env or admin Key Vault). Subscription
// lifecycle / entitlements are stubbed for a later pass. Prices are defined
// inline so no Stripe dashboard setup is needed to see Checkout working.

import "server-only";
import { getConfig } from "./runtime-config";

export interface Plan {
  id: string;
  name: string;
  blurb: string;
  amount: number; // cents / month
  features: string[];
  highlight?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    blurb: "For occasional trips",
    amount: 0,
    features: ["Live agent search", "Map + list", "Up to 10 vendors / run"],
  },
  {
    id: "pro",
    name: "Pro Traveller",
    blurb: "Best for frequent travellers",
    amount: 900,
    features: [
      "Unlimited vendors / run",
      "Priority negotiation agents",
      "Saved trips & alerts",
      "Advanced filters",
    ],
    highlight: true,
  },
  {
    id: "fleet",
    name: "Fleet / Business",
    blurb: "Teams & partners",
    amount: 4900,
    features: [
      "Team seats",
      "API access",
      "Vendor CRM",
      "Dedicated support",
    ],
  },
];

export async function stripeConfigured(): Promise<boolean> {
  return Boolean(await getConfig("STRIPE_SECRET_KEY"));
}

/** Create a Checkout Session for a subscription plan. */
export async function createCheckoutSession(
  planId: string,
  origin: string
): Promise<{ url?: string; error?: string; configured: boolean }> {
  const key = await getConfig("STRIPE_SECRET_KEY");
  if (!key) return { configured: false, error: "Stripe is not configured yet." };

  const plan = PLANS.find((p) => p.id === planId);
  if (!plan || plan.amount === 0) {
    return { configured: true, error: "Choose a paid plan." };
  }

  // Stripe expects application/x-www-form-urlencoded with bracketed keys.
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][unit_amount]": String(plan.amount),
    "line_items[0][price_data][product_data][name]": `WheelDeal ${plan.name}`,
    success_url: `${origin}/admin?billing=success`,
    cancel_url: `${origin}/admin?billing=cancelled`,
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return { configured: true, error: data?.error?.message ?? `Stripe ${res.status}` };
    }
    return { configured: true, url: data.url };
  } catch (e) {
    return {
      configured: true,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}
