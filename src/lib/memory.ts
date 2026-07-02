// Continuous Learning Engine - shared negotiation-tactic memory.
//
// In production this table lives in Supabase so learning accumulates across all
// users and server instances. Here we keep a process-level singleton that seeds
// a starter playbook and updates win-rates as negotiations resolve. The API
// surface is identical, so swapping in a Supabase-backed implementation is a
// drop-in change (see db.ts).

import type { NegotiationTactic } from "./types";

const STARTER: NegotiationTactic[] = [
  {
    id: "anchor-low",
    label: "Anchor low",
    script:
      "Thanks! I'm comparing a few nearby partners. My target is {target}/day for the {vehicle}. Can you meet that?",
    uses: 12,
    wins: 7,
    avgDiscountPct: 11,
  },
  {
    id: "competitor-beat",
    label: "Beat the competitor",
    script:
      "I've been quoted {rival}/day for a similar {vehicle} nearby - if you can beat it I'll book with you right now.",
    uses: 18,
    wins: 12,
    avgDiscountPct: 14,
  },
  {
    id: "multi-day",
    label: "Length discount",
    script:
      "I'm renting for {days} days. What's your best long-stay rate if I commit today?",
    uses: 9,
    wins: 5,
    avgDiscountPct: 9,
  },
  {
    id: "bundle-delivery",
    label: "Bundle delivery",
    script:
      "Could you include free hotel delivery at {target}/day? That would seal it for me.",
    uses: 7,
    wins: 4,
    avgDiscountPct: 8,
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_memory__:
    | { tactics: NegotiationTactic[]; runs: number; offers: number; cycleSecTotal: number }
    | undefined;
}

function store() {
  if (!globalThis.__wheeldeal_memory__) {
    globalThis.__wheeldeal_memory__ = {
      tactics: STARTER.map((t) => ({ ...t })),
      runs: 0,
      offers: 0,
      cycleSecTotal: 0,
    };
  }
  return globalThis.__wheeldeal_memory__;
}

export function getTactics(): NegotiationTactic[] {
  // Rank by a blended score of win-rate and average discount so the most
  // battle-tested tactics surface first (the "stepping up" behaviour).
  return [...store().tactics].sort(
    (a, b) => score(b) - score(a)
  );
}

function score(t: NegotiationTactic): number {
  const winRate = t.uses > 0 ? t.wins / t.uses : 0;
  return winRate * 0.6 + (t.avgDiscountPct / 20) * 0.4;
}

/** Record the outcome of using a tactic - the core learning update. */
export function recordOutcome(
  tacticId: string,
  won: boolean,
  discountPct: number
) {
  const t = store().tactics.find((x) => x.id === tacticId);
  if (!t) return;
  t.uses += 1;
  if (won) t.wins += 1;
  // Exponential moving average keeps recent results weighted.
  t.avgDiscountPct = Number(
    (t.avgDiscountPct * 0.8 + discountPct * 0.2).toFixed(1)
  );
}

export function recordRun(offers: number, cycleSeconds: number) {
  const s = store();
  s.runs += 1;
  s.offers += offers;
  s.cycleSecTotal += cycleSeconds;
}

// ---- Owner-taught training examples (real bargaining transcripts) ------------

export interface TrainingExample {
  id: number;
  text: string;
  note?: string;
  addedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_training__: TrainingExample[] | undefined;
}

function trainingStore() {
  if (!globalThis.__wheeldeal_training__) globalThis.__wheeldeal_training__ = [];
  return globalThis.__wheeldeal_training__;
}

export function addTraining(text: string, note?: string): TrainingExample {
  const ex: TrainingExample = {
    id: Date.now(),
    text: text.slice(0, 4000),
    note,
    addedAt: Date.now(),
  };
  trainingStore().push(ex);
  return ex;
}

export function listTraining(): TrainingExample[] {
  return [...trainingStore()].sort((a, b) => b.addedAt - a.addedAt);
}

export function analytics() {
  const s = store();
  const ranked = getTactics();
  const avgDiscount =
    ranked.reduce((sum, t) => sum + t.avgDiscountPct * t.uses, 0) /
    Math.max(1, ranked.reduce((sum, t) => sum + t.uses, 0));
  return {
    totalRuns: s.runs,
    totalOffers: s.offers,
    avgDiscountPct: Number(avgDiscount.toFixed(1)),
    avgCycleSeconds:
      s.runs > 0 ? Number((s.cycleSecTotal / s.runs).toFixed(1)) : 0,
    bestTactic: ranked[0]?.label ?? null,
    tactics: ranked,
  };
}
