// The plan catalogue - provider-neutral (no payment SDK, no server-only), so
// both server routes and client pricing UI can import it. Payment is handled by
// src/lib/paypal.ts; this file only describes WHAT the tiers are.
//
// Plans bill every 3 MONTHS (quarterly) at the prices below. Owner and
// management hold the Ultra plan automatically, free.
//
// ONE PRICE SOURCE, AND IT USED TO BE WRONG.
//
// There were two disagreeing price sources. This file computed Pro 5.40 /
// Ultra 29.40 by applying an 80% `LAUNCH_DISCOUNT` to a list price, while
// UpgradeSheet.tsx hardcoded 16.50 / 88 in its own ILS map with a comment
// claiming those "match the PayPal billing plans exactly". The hardcoded pair
// was the truth - PayPal charges 16.50 / 88 - so every figure this module
// produced was fiction, and any consumer that trusted it under-reported revenue
// by ~3x.
//
// The discount is now gone entirely (owner decision, plan C.0.2): there is no
// launch price, no introductory quarter, and no list price to strike through.
// What replaces it is not cheaper access but *gated* access - a paid plan
// cannot be purchased until the account is warmed up (src/lib/warmup.ts). A
// discount pays people to tolerate a warm-up; a gate makes them want to finish
// it.
//
// `amount` is therefore the real charged price, denominated in ILS agorot, and
// it is the only price in the codebase.

import type { PlanId } from "./access";

export type { PlanId };

export interface Plan {
  id: PlanId;
  name: string;
  blurb: string;
  /** Minor units (ILS agorot) per 3 months. The amount PayPal actually charges. */
  amount: number;
  features: string[];
  highlight?: boolean;
}

/** The currency `amount` is denominated in. Display converts from here. */
export const PLAN_CURRENCY = "ILS";

function plan(
  id: PlanId,
  name: string,
  blurb: string,
  amount: number,
  features: string[],
  highlight?: boolean
): Plan {
  return { id, name, blurb, amount, features, highlight };
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
    1650,
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
  plan("ultra", "Ultra", "The ultimate bargaining machine", 8800, [
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

/** The charged price in whole ILS, for display and currency conversion. */
export function planPriceIls(id: string): number {
  return planById(id).amount / 100;
}

export function planById(id: string | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
