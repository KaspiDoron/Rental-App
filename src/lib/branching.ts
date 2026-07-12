// The branching engine - the enterprise, data-driven decision core that decides
// the ALLOWED move for every inbound shop reply. It replaces the old hardcoded
// if/else ladder with an ordered graph of typed rules the owner can edit, test,
// reorder and extend without touching code.
//
// Design goals: 100% pure (no I/O, no Supabase, no LLM), 100% modular, 100%
// testable. The caller (agent-loop) builds a DecisionContext of plain booleans
// from the thread + extraction, then decide() walks the graph and returns the
// first enabled rule whose condition matches. Because it is pure, the exact same
// engine powers the live loop AND the owner's dry-run simulator + unit tests.

export type Direction = "clarify" | "answer" | "bargain" | "close" | "silent";

// Everything the engine needs to know about the current turn, as plain data.
export interface DecisionContext {
  sessionClosed: boolean;
  shopAskedQuestion: boolean;
  shopSentVehiclePhoto: boolean;
  hasUsablePrice: boolean;
  verified: boolean;
  hasClarifyMessage: boolean;
  matchesSpecNotFalse: boolean;
  // usablePrice is already at/below the local market floor (a great price).
  priceAtOrBelowFloor: boolean;
  // Our computed bargain target is a genuine saving vs the quote (< 95%).
  targetIsRealSaving: boolean;
  rivalCheaper: boolean;
  // How many times each move already fired in THIS shop's thread (ask-once).
  counts: { clarify: number; bargain: number; answer: number; close: number };
}

type CounterName = "clarify" | "bargain" | "answer" | "close";

// A typed predicate vocabulary - NO free-text / arbitrary code, so a bad owner
// edit can never execute anything or crash the loop. New edge cases are added by
// extending this union and the evaluator below.
export type Condition =
  | { kind: "always" }
  | { kind: "sessionClosed" }
  | { kind: "shopAskedQuestion" }
  | { kind: "shopSentVehiclePhoto" }
  | { kind: "hasUsablePrice"; value: boolean }
  | { kind: "verified"; value: boolean }
  | { kind: "hasClarifyMessage" }
  | { kind: "matchesSpecNotFalse" }
  | { kind: "priceAtOrBelowFloor"; value: boolean }
  | { kind: "targetIsRealSaving"; value: boolean }
  | { kind: "rivalCheaper" }
  | { kind: "counterBelow"; counter: CounterName; max: number }
  | { kind: "counterAtLeast"; counter: CounterName; min: number }
  | { kind: "not"; of: Condition }
  | { kind: "all"; of: Condition[] }
  | { kind: "any"; of: Condition[] };

export interface BranchRule {
  id: string;
  label: string; // owner-renamable name shown in the panel + traces
  enabled: boolean;
  order: number;
  when: Condition;
  then: { direction: Direction };
}

export interface DecisionGraph {
  version: 1;
  rules: BranchRule[];
}

export interface Decision {
  direction: Direction;
  ruleId: string | null;
  why: string;
}

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------

function counterOf(ctx: DecisionContext, c: CounterName): number {
  return ctx.counts[c] ?? 0;
}

export function evalCondition(cond: Condition, ctx: DecisionContext): boolean {
  switch (cond.kind) {
    case "always":
      return true;
    case "sessionClosed":
      return ctx.sessionClosed;
    case "shopAskedQuestion":
      return ctx.shopAskedQuestion;
    case "shopSentVehiclePhoto":
      return ctx.shopSentVehiclePhoto;
    case "hasUsablePrice":
      return ctx.hasUsablePrice === cond.value;
    case "verified":
      return ctx.verified === cond.value;
    case "hasClarifyMessage":
      return ctx.hasClarifyMessage;
    case "matchesSpecNotFalse":
      return ctx.matchesSpecNotFalse;
    case "priceAtOrBelowFloor":
      return ctx.priceAtOrBelowFloor === cond.value;
    case "targetIsRealSaving":
      return ctx.targetIsRealSaving === cond.value;
    case "rivalCheaper":
      return ctx.rivalCheaper;
    case "counterBelow":
      return counterOf(ctx, cond.counter) < cond.max;
    case "counterAtLeast":
      return counterOf(ctx, cond.counter) >= cond.min;
    case "not":
      return !evalCondition(cond.of, ctx);
    case "all":
      return cond.of.every((c) => evalCondition(c, ctx));
    case "any":
      return cond.of.some((c) => evalCondition(c, ctx));
    default:
      return false;
  }
}

/**
 * Walk the graph in `order` and return the first ENABLED rule whose condition
 * matches. Falls back to a safe `silent` when nothing matches or the graph is
 * empty/misconfigured - the most human move is to say nothing.
 */
export function decide(ctx: DecisionContext, graph: DecisionGraph): Decision {
  const rules = [...(graph.rules ?? [])]
    .filter((r) => r && r.enabled)
    .sort((a, b) => a.order - b.order);
  for (const r of rules) {
    try {
      if (evalCondition(r.when, ctx)) {
        return { direction: r.then.direction, ruleId: r.id, why: r.label };
      }
    } catch {
      // A malformed rule can never break the loop - skip it.
      continue;
    }
  }
  return {
    direction: "silent",
    ruleId: null,
    why: "nothing owed - silence is the most human move",
  };
}

// ---------------------------------------------------------------------------
// Built-in default graph - a faithful, extensible encoding of the discipline
// the app has always enforced (answer questions, clarify once, bargain once
// toward the floor, close once, respect a closed session), plus the new
// vehicle-photo branch. Owners edit copies of this; the defaults are always the
// safe fallback.
// ---------------------------------------------------------------------------

export function defaultDecisionGraph(): DecisionGraph {
  const rules: BranchRule[] = [
    {
      id: "session-closed",
      label: "Closed session stays silent",
      enabled: true,
      order: 10,
      when: { kind: "sessionClosed" },
      then: { direction: "silent" },
    },
    {
      id: "answer-question",
      label: "Answer the shop's question",
      enabled: true,
      order: 20,
      when: {
        kind: "all",
        of: [{ kind: "shopAskedQuestion" }, { kind: "counterBelow", counter: "answer", max: 2 }],
      },
      then: { direction: "answer" },
    },
    {
      id: "thank-vehicle-photo",
      label: "Thank the shop for a vehicle photo",
      enabled: true,
      order: 30,
      when: {
        kind: "all",
        of: [
          { kind: "shopSentVehiclePhoto" },
          { kind: "hasUsablePrice", value: false },
          { kind: "counterBelow", counter: "answer", max: 2 },
        ],
      },
      then: { direction: "answer" },
    },
    {
      id: "clarify-once",
      label: "Clarify once when no price yet",
      enabled: true,
      order: 40,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: false },
          { kind: "verified", value: false },
          { kind: "hasClarifyMessage" },
          { kind: "counterBelow", counter: "clarify", max: 1 },
        ],
      },
      then: { direction: "clarify" },
    },
    {
      id: "close-great-price",
      label: "Close warmly on an at/below-floor price",
      enabled: true,
      order: 50,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: true },
          { kind: "matchesSpecNotFalse" },
          { kind: "counterBelow", counter: "bargain", max: 1 },
          { kind: "priceAtOrBelowFloor", value: true },
          { kind: "counterBelow", counter: "close", max: 1 },
        ],
      },
      then: { direction: "close" },
    },
    {
      id: "silent-great-price-closed",
      label: "Stay silent once a great price was thanked",
      enabled: true,
      order: 55,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: true },
          { kind: "matchesSpecNotFalse" },
          { kind: "counterBelow", counter: "bargain", max: 1 },
          { kind: "priceAtOrBelowFloor", value: true },
        ],
      },
      then: { direction: "silent" },
    },
    {
      id: "close-no-real-saving",
      label: "Close when no genuine saving is possible",
      enabled: true,
      order: 60,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: true },
          { kind: "matchesSpecNotFalse" },
          { kind: "counterBelow", counter: "bargain", max: 1 },
          { kind: "priceAtOrBelowFloor", value: false },
          { kind: "targetIsRealSaving", value: false },
          { kind: "counterBelow", counter: "close", max: 1 },
        ],
      },
      then: { direction: "close" },
    },
    {
      id: "silent-no-real-saving-closed",
      label: "Stay silent when no saving and already thanked",
      enabled: true,
      order: 65,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: true },
          { kind: "matchesSpecNotFalse" },
          { kind: "counterBelow", counter: "bargain", max: 1 },
          { kind: "priceAtOrBelowFloor", value: false },
          { kind: "targetIsRealSaving", value: false },
        ],
      },
      then: { direction: "silent" },
    },
    {
      id: "bargain-once",
      label: "Bargain once toward the floor",
      enabled: true,
      order: 70,
      when: {
        kind: "all",
        of: [
          { kind: "hasUsablePrice", value: true },
          { kind: "matchesSpecNotFalse" },
          { kind: "counterBelow", counter: "bargain", max: 1 },
          { kind: "priceAtOrBelowFloor", value: false },
          { kind: "targetIsRealSaving", value: true },
        ],
      },
      then: { direction: "bargain" },
    },
    {
      id: "close-after-bargain",
      label: "Thank once after our single ask",
      enabled: true,
      order: 80,
      when: {
        kind: "all",
        of: [
          { kind: "counterAtLeast", counter: "bargain", min: 1 },
          { kind: "counterBelow", counter: "close", max: 1 },
        ],
      },
      then: { direction: "close" },
    },
  ];
  return { version: 1, rules };
}
