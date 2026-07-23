// Will's command vocabulary - the typed contract between natural language
// and the existing search-session controls. Isomorphic on purpose: the API
// route parses INTO these commands, the client executes them against the
// exact same setters the visible controls use (Will can never do anything
// the UI can't).

import type { FilterState } from "@/components/Filters";

export type WillCommand =
  | { action: "set_radius"; km: number }
  | { action: "set_filter"; patch: Partial<FilterState>; label?: string }
  | { action: "set_budget"; maxPricePerDay: number | null }
  | { action: "start_search"; text?: string }
  | { action: "clear_search" }
  | { action: "pause_session" }
  | { action: "resume_session" }
  | { action: "mass_bargain" }
  | { action: "compare"; vendorIds: string[] }
  | { action: "open_vendor"; vendorId: string }
  | { action: "remember"; note: string }
  // Navigation + product guidance - Will is the app's operating system.
  | { action: "open_deals" }
  | { action: "open_pricing" }
  | { action: "open_feedback"; topic?: string }
  | { action: "help" }
  | { action: "answer"; text: string }
  | { action: "clarify"; text: string };

export interface WillVendorSnapshot {
  id: string;
  name: string;
  stage?: string;
  pricePerDay?: number;
  currency?: string;
  verified?: boolean;
}

/** Compact client snapshot sent with every message - Will's eyes. */
export interface WillContext {
  phase: "idle" | "profiling" | "running" | "done";
  radiusKm: number;
  vehicleClass?: string;
  maxPricePerDay?: number | null;
  vendors: WillVendorSnapshot[]; // top ~12, cheapest-first where priced
  offersIn: number;
  waConnected: boolean;
  plan: string;
  originLabel?: string;
  paused: boolean;
  notes: string[]; // standing instructions from "remember ..."
}

export function clampRadius(km: number): number {
  return Math.min(25, Math.max(2, Math.round(km)));
}

/** Top-N vendors by cheapest offer first, then by presence in the list. */
export function topVendors(ctx: WillContext, n: number): WillVendorSnapshot[] {
  const priced = ctx.vendors.filter((v) => (v.pricePerDay ?? 0) > 0);
  priced.sort((a, b) => (a.pricePerDay ?? 0) - (b.pricePerDay ?? 0));
  const rest = ctx.vendors.filter((v) => !((v.pricePerDay ?? 0) > 0));
  return [...priced, ...rest].slice(0, n);
}

/** Fuzzy vendor lookup by (partial) name. */
export function findVendor(ctx: WillContext, name: string): WillVendorSnapshot | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  return (
    ctx.vendors.find((v) => v.name.toLowerCase() === q) ??
    ctx.vendors.find((v) => v.name.toLowerCase().includes(q))
  );
}

/**
 * The keyless fallback (and the fast path for unambiguous commands): a
 * regex/keyword table. Returns null when the text needs the LLM (or a
 * clarify). Unit-tested in will-commands.test.ts.
 */
export function parseWillCommandDeterministic(
  text: string,
  ctx: WillContext
): WillCommand | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;

  // Product guidance + navigation - Will is the app's control center.
  if (/^(help|what can you do|what do you do|how do (?:you|i) work|capabilities)\b/.test(s)) {
    return { action: "help" };
  }
  if (/\b(open|show|go to|see)\b.*\b(deals?|trips?|bookings?|my hunts?)\b|^my (deals?|trips?)$/.test(s)) {
    return { action: "open_deals" };
  }
  if (/\b(plans?|pricing|upgrade|pro|ultra)\b.*\b(cost|price|difference|include|what|show|compare)\b|\bwhat.*\b(pro|ultra|plans?)\b|^(show )?(plans|pricing)$/.test(s)) {
    return { action: "open_pricing" };
  }

  // Feedback / bug reports / complaints / feature requests -> guide the user
  // to the feedback flow (and open it). Conservative triggers so ordinary chat
  // about a SHOP being closed/broken never fires this.
  if (
    /\b(report (a |an )?(bug|problem|issue|glitch)|(give|send|leave|submit|write) (some )?feedback|feature request|request a feature|i(?:'| a)?m? ?want(?: to)? suggest|suggestion for (the )?app|complain)\b/.test(
      s
    ) ||
    /\b(this|the) (app|page|button|screen|feature)\b.*\b(broke|broken|bug|doesn'?t work|not working|isn'?t working|is wrong)\b/.test(
      s
    ) ||
    /^(feedback|report a bug|bug report|give feedback)$/.test(s)
  ) {
    return { action: "open_feedback" };
  }

  // "Same search session" - a recurring point of confusion Will should own.
  if (/\bsearch session\b|\bsame search\b|\bwhat (counts as|is) (a|the) (search )?session\b/.test(s)) {
    return { action: "answer", text: "__SESSION__" };
  }

  // Capacity / limits / "how many shops" / "why is it queued" explained in
  // plain language (no ban-jargon) - the route composes it plan-aware.
  if (
    /\b(how many (shops|messages|introductions)|new shops per|daily limit|message limit|sending limit|how many.*(introduc|contact)|why (is it |are they )?(queued|waiting|paced|slow|taking))\b/.test(
      s
    )
  ) {
    return { action: "answer", text: "__CAPACITY__" };
  }

  // Radius: "expand search radius to 5km", "radius 12", "search wider"
  const radius = s.match(/(?:radius|distance)[^\d]{0,12}(\d{1,2})(?:\s*km)?|(\d{1,2})\s*km\s*(?:radius|around|near)?$/);
  if (radius && /radius|km|wider|distance/.test(s)) {
    const km = Number(radius[1] ?? radius[2]);
    if (Number.isFinite(km) && km > 0) return { action: "set_radius", km: clampRadius(km) };
  }
  if (/\b(wider|expand|larger|bigger)\b.*\b(search|radius|area)\b|\b(search|radius|area)\b.*\b(wider|expand|larger|bigger)\b/.test(s)) {
    return { action: "set_radius", km: clampRadius(ctx.radiusKm + 5) };
  }

  // Budget: "under $10/day", "only options below 200", "budget 150"
  const budget = s.match(/(?:under|below|less than|max(?:imum)?|budget(?: of)?|cap at)\s*\$?([\d.,]{1,7})/);
  if (budget) {
    const v = Number(budget[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0) return { action: "set_budget", maxPricePerDay: v };
  }
  if (/\b(remove|clear|no)\b.*\bbudget\b/.test(s)) return { action: "set_budget", maxPricePerDay: null };

  // Vehicle class: "only show automatic scooters", "cars only", "motorbikes"
  if (/\bonly\b.*\bscooter|scooter\w*\s+only/.test(s)) {
    return { action: "set_filter", patch: { vehicleClass: "scooter" } as Partial<FilterState>, label: "scooters only" };
  }
  if (/\bonly\b.*\b(motorbike|motorcycle)|(?:motorbike|motorcycle)\w*\s+only/.test(s)) {
    return { action: "set_filter", patch: { vehicleClass: "motorbike" } as Partial<FilterState>, label: "motorbikes only" };
  }
  if (/\bonly\b.*\bcar|cars?\s+only/.test(s)) {
    return { action: "set_filter", patch: { vehicleClass: "car" } as Partial<FilterState>, label: "cars only" };
  }

  // Delivery / rating filters
  if (/\b(delivery|deliver(ed)? to (me|my hotel))\b.*\bonly\b|\bonly\b.*\bdeliver/.test(s)) {
    return { action: "set_filter", patch: { deliveryOnly: true } as Partial<FilterState>, label: "delivery only" };
  }
  const stars = s.match(/(\d(?:\.\d)?)\s*stars?(?:\s*(?:\+|or (?:more|better|above)))?/);
  if (stars && /star/.test(s) && /only|at least|minimum|above|\+|or more|or better/.test(s)) {
    const v = Number(stars[1]);
    if (v >= 1 && v <= 5) return { action: "set_filter", patch: { minRating: v } as Partial<FilterState>, label: `${v}+ stars` };
  }

  // Pause / resume
  if (/\b(pause|hold|stop for now|freeze)\b/.test(s) && !/\bdon'?t\b/.test(s)) {
    return { action: "pause_session" };
  }
  if (/\b(resume|continue|unpause|keep going|carry on)\b/.test(s)) {
    return { action: "resume_session" };
  }

  // Mass bargain / push harder
  if (/\b(mass bargain|ask (all|every) shops?|bargain (with )?(all|every)|negotiat\w+ harder|push harder)\b/.test(s)) {
    return { action: "mass_bargain" };
  }

  // Compare: "compare the top 3", "compare best two"
  const cmp = s.match(/\bcompare\b.*?\b(?:top|best)?\s*(\d|two|three)\b/);
  if (/\bcompare\b/.test(s)) {
    const nRaw = cmp?.[1];
    const n = nRaw === "two" ? 2 : nRaw === "three" ? 3 : Number(nRaw) || 3;
    const ids = topVendors(ctx, Math.min(Math.max(n, 2), 3)).map((v) => v.id);
    if (ids.length >= 2) return { action: "compare", vendorIds: ids };
  }

  // Clear search
  if (/\b(clear|reset|start over|new search from scratch)\b.*\bsearch\b|\bsearch\b.*\b(clear|reset)\b|^(clear|reset|start over)$/.test(s)) {
    return { action: "clear_search" };
  }

  // Remember a standing instruction
  const rem = text.match(/^(?:remember|from now on|always)[:,]?\s+(.{4,200})/i);
  if (rem) return { action: "remember", note: rem[1].trim() };

  // Status / why questions -> the route composes the answer server-side; we
  // just signal the intent with a special marker the route understands.
  if (/\bwhat(?:'s| is| are)\b.*\b(happening|going on|doing|status)\b|\bstatus\b|\bany (news|update)/.test(s)) {
    return { action: "answer", text: "__STATUS__" };
  }
  if (/\bwhy\b.*\b(this|that|best|cheapest|picked|selected|chose|move)\b/.test(s)) {
    return { action: "answer", text: "__WHY__" };
  }

  return null;
}
