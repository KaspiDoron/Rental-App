// Stripe billing via the REST API - no SDK dependency.
//
// Plans bill every 3 MONTHS (quarterly) and carry a limited-time launch
// discount of 80% off the list price. Real Checkout Sessions are created when
// STRIPE_SECRET_KEY is configured (env or admin Key Vault); the full
// subscription lifecycle lands in a later pass.

import "server-only";
import { getConfig } from "./runtime-config";

export interface Plan {
  id: string;
  name: string;
  blurb: string;
  listAmount: number; // cents per 3 months, before discount
  amount: number; // cents per 3 months, launch price actually charged
  discountPct: number;
  features: string[];
  highlight?: boolean;
}

const LAUNCH_DISCOUNT = 0.8; // 80% off, limited-time opening offer

function plan(
  id: string,
  name: string,
  blurb: string,
  listAmount: number,
  features: string[],
  highlight?: boolean
): Plan {
  return {
    id,
    name,
    blurb,
    listAmount,
    amount: Math.round(listAmount * (1 - LAUNCH_DISCOUNT)),
    discountPct: LAUNCH_DISCOUNT * 100,
    features,
    highlight,
  };
}

export const PLANS: Plan[] = [
  plan("starter", "Starter", "For occasional trips", 0, [
    "Live agent search",
    "Map + list",
    "Up to 10 vendors per run",
  ]),
  plan(
    "pro",
    "Pro Traveller",
    "Best for frequent travellers",
    2700,
    [
      "100% ad-free experience",
      "Unlimited vendors per run",
      "Priority negotiation agents",
      "Saved trips & alerts",
      "Advanced filters",
    ],
    true
  ),
  plan("fleet", "Fleet / Business", "Teams & partners", 14700, [
    "100% ad-free experience",
    "Team seats",
    "API access",
    "Vendor CRM",
    "Dedicated support",
  ]),
];

export async function stripeConfigured(): Promise<boolean> {
  return Boolean(await getConfig("STRIPE_SECRET_KEY"));
}

/** Create a quarterly-subscription Checkout Session at the launch price. */
export async function createCheckoutSession(
  planId: string,
  origin: string
): Promise<{ url?: string; error?: string; configured: boolean }> {
  const key = await getConfig("STRIPE_SECRET_KEY");
  if (!key) return { configured: false, error: "Stripe is not configured yet." };

  const p = PLANS.find((x) => x.id === planId);
  if (!p || p.amount === 0) {
    return { configured: true, error: "Choose a paid plan." };
  }

  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][recurring][interval]": "month",
    "line_items[0][price_data][recurring][interval_count]": "3",
    "line_items[0][price_data][unit_amount]": String(p.amount),
    "line_items[0][price_data][product_data][name]": `WheelDeal ${p.name} (launch offer, billed every 3 months)`,
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancelled`,
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
