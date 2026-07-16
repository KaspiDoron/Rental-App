// Continuous Learning Engine - shared negotiation-tactic memory.
//
// The synchronous read API (getTactics/recordOutcome) keeps serving from a
// process-level singleton so hot callers never await a query - but the table
// is now DURABLE: hydrateTactics() (called from the async entry points)
// refreshes the singleton from Supabase agent_tactics every 30s, and
// recordOutcome writes each learning update through fire-and-forget. Learning
// therefore accumulates across users, instances and deploys; without Supabase
// everything degrades to the old in-process behavior.

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

let hydratedAt = 0;

/**
 * Refresh the in-process tactic table from the durable agent_tactics table
 * (seeding it with the starter playbook on first contact). Callers on async
 * paths await this once before getTactics(); 30s cache keeps it one query.
 */
export async function hydrateTactics(): Promise<void> {
  if (Date.now() - hydratedAt < 30_000) return;
  hydratedAt = Date.now();
  try {
    const { sbSelect, sbInsert, supabaseConfigured } = await import("./runtime-config");
    if (!supabaseConfigured()) return;
    const rows = await sbSelect<{
      id: string;
      label: string;
      script: string;
      uses: number | null;
      wins: number | null;
      avg_discount_pct: number | null;
    }>("agent_tactics", "select=id,label,script,uses,wins,avg_discount_pct&limit=50");
    if (rows.length === 0) {
      // First contact: persist the starter playbook so learning has a durable home.
      await sbInsert(
        "agent_tactics",
        STARTER.map((t) => ({
          id: t.id,
          label: t.label,
          script: t.script,
          uses: t.uses,
          wins: t.wins,
          avg_discount_pct: t.avgDiscountPct,
        })),
        "id"
      );
      return;
    }
    const s = store();
    for (const r of rows) {
      if (!r.id) continue;
      const mapped: NegotiationTactic = {
        id: r.id,
        label: r.label ?? r.id,
        script: r.script ?? "",
        uses: r.uses ?? 0,
        wins: r.wins ?? 0,
        avgDiscountPct: Number(r.avg_discount_pct ?? 0),
      };
      const existing = s.tactics.find((t) => t.id === r.id);
      if (existing) Object.assign(existing, mapped);
      else s.tactics.push(mapped);
    }
  } catch {
    /* durable memory is best-effort - the in-process table still serves */
  }
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
  // Write-through so the learning survives cold starts and reaches every
  // instance. Fire-and-forget: the caller never waits on durability.
  void (async () => {
    try {
      const { sbUpdate, supabaseConfigured } = await import("./runtime-config");
      if (!supabaseConfigured()) return;
      await sbUpdate("agent_tactics", `id=eq.${encodeURIComponent(t.id)}`, {
        uses: t.uses,
        wins: t.wins,
        avg_discount_pct: t.avgDiscountPct,
        updated_at: new Date().toISOString(),
      });
    } catch {
      /* best-effort */
    }
  })();
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

/** Remove an in-memory example by id (durable rows are deleted in Supabase). */
export function deleteTraining(id: number): boolean {
  const s = trainingStore();
  const i = s.findIndex((e) => e.id === id);
  if (i === -1) return false;
  s.splice(i, 1);
  return true;
}

/** Edit an in-memory example's text (durable rows are patched in Supabase). */
export function updateTraining(id: number, text: string): boolean {
  const e = trainingStore().find((x) => x.id === id);
  if (!e) return false;
  e.text = text.slice(0, 4000);
  return true;
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
