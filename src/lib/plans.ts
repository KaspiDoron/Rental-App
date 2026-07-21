// The plan catalogue - provider-neutral (no payment SDK, no server-only), so
// both server routes and client pricing UI can import it. Payment is handled by
// src/lib/paypal.ts; this file only describes WHAT the tiers are.
//
// Plans bill every 3 MONTHS (quarterly) with an 80% limited-time launch
// discount. Owner and management hold the Ultra plan automatically, free.

import type { PlanId } from "./access";

export type { PlanId };

export interface Plan {
  id: PlanId;
  name: string;
  blurb: string;
  listAmount: number; // minor units per 3 months, before discount (ILS agorot)
  amount: number; // minor units per 3 months, launch price actually charged
  discountPct: number;
  features: string[];
  highlight?: boolean;
}

export const LAUNCH_DISCOUNT = 0.8;

function plan(
  id: PlanId,
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
  plan("free", "Free", "Start saving today", 0, [
    "Live agent search",
    "Map + list",
    "Same-day pickup scheduling only",
  ]),
  plan(
    "pro",
    "Pro Traveller",
    "Best for frequent travellers",
    2700,
    [
      "100% ad-free experience",
      "Priority negotiation agents",
      "Mass bargain: ask many shops at once",
      "Schedule pickups for future days",
      "Saved trips & full order history",
      "AI order-status assistant while searching",
    ],
    true
  ),
  plan("ultra", "Ultra", "The ultimate bargaining machine", 14700, [
    "Everything in Pro",
    "Agents bargain in the shop's LOCAL language - real street talk",
    "Locals-only pricing: agents anchor to the real local market floor",
    "See the English translation of every local-language message",
    "Fast-responder insights: which shops reply quickest",
    "Unlimited daily searches & AI actions (fair use)",
    "Instant alerts when a cheaper verified offer lands",
    "VIP support & early access to new agents",
  ]),
];

export function planById(id: string | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
