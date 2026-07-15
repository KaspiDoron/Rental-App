// The default negotiation digraph - a faithful superset of the legacy
// discipline ladder (branching.ts), extended with the full deal playbook:
// multi-round bargaining, deposit + fulfillment probing before anything is
// presented, the passport->cash push, pickup consent, media coherence and the
// close-deal handoff. Owners edit COPIES of this; the defaults are always the
// safe fallback, and disabling the new nodes reproduces the legacy behavior
// exactly (proven by the parity tests).

import type { EdgeSpec, GraphCondition, GraphFacts, GraphSettings, GraphSpec, NodeSpec } from "./types";
import type { BranchRule } from "../branching";
import { evalGraphCondition } from "./conditions";

export const GRAPH_SPEC_VERSION = 2 as const;

export function defaultGraphSettings(): GraphSettings {
  return {
    maxStepsPerEvent: 8,
    maxLlmCallsPerEvent: 5,
    maxRoundsPerShop: 3,
    waitWindow: { minS: 120, maxS: 900 },
    strategicWaitMaxMin: 45,
    emojiTone: true,
    judgeSampleRate: 1,
    lowEnglish: true,
    streetLocal: true,
  };
}

function n(
  id: string,
  kind: NodeSpec["kind"],
  label: string,
  emoji: string,
  extra?: Partial<NodeSpec>
): NodeSpec {
  return { id, kind, label, emoji, enabled: true, instructions: "", ...extra };
}

export function defaultGraphNodes(): NodeSpec[] {
  return [
    n("inbound", "entry", "Inbound event", "📥"),
    // ---- sense ----
    n("transcribe", "transcribe", "Voice Transcriber - heavy-accent voice notes", "🎙️", {
      instructions:
        "Transcribe shop voice notes exactly, digit-perfect on prices. Expect heavy local accents and mixed local words.",
    }),
    n("extract", "extract", "Offer Extractor - reads text + photos", "🔎", {
      instructions:
        "Read prices from text and photos (price tables, odometer, condition). Total quotes divide into per-day. Never invent.",
    }),
    n("coherence", "media-coherence", "Media Coherence Validator", "🧿", {
      instructions:
        "Check every image/voice interpretation against the WHOLE conversation - currency scale, vehicle match, numbers consistent.",
    }),
    n("comparator", "comparator", "Market & Rival Comparator", "⚖️", {
      instructions:
        "Anchor on the real local floor. Use the cheapest rival offer from THIS search session as honest leverage.",
    }),
    // ---- chief ----
    n("director", "director", "Negotiation Director", "🧠", {
      instructions:
        "Patience is leverage. Only respond when we hold the best position; let the shop send the last message. Prefer cash deposits over passport.",
    }),
    // ---- act ----
    n("answer", "answer", "Answer the shop", "💬", { maxRunsPerThread: 4 }),
    n("clarify", "clarify", "Clarify the offer", "❓", { maxRunsPerThread: 2 }),
    n("bargain", "bargain", "Bargainer", "🥊", {
      instructions:
        "One friendly ask per round, anchored to the floor and the best rival offer. Warm, casual, one emoji, easy to say yes to.",
    }),
    n("deposit-probe", "deposit-probe", "Deposit Negotiator", "🛂", {
      maxRunsPerThread: 3,
      instructions:
        "Always learn the deposit before the traveller sees the deal. Prefer cash over passport - if passport-only, ask nicely ONCE for a cash alternative.",
    }),
    n("fulfillment-probe", "fulfillment-probe", "Fulfillment Prober", "🛵", {
      maxRunsPerThread: 2,
      instructions:
        "Learn how the traveller gets the vehicle: delivery to the hotel, shop pickup service, or on-shop only.",
    }),
    n("present", "present", "Present deal to traveller", "🎁"),
    n("close", "close", "Warm closer", "🤝", { maxRunsPerThread: 2 }),
    n("pickup-location", "pickup-location", "Share pickup location", "📍", {
      maxRunsPerThread: 2,
      instructions: "Send the traveller's exact location ONLY after they approved it on the card.",
    }),
    n("closing-message", "closing-message", "Deal-close messenger", "✅", { maxRunsPerThread: 2 }),
    n("silent", "silent", "Deliberate silence", "🤫"),
    // ---- tail gates ----
    n("style-validator", "style-validator", "Style & Uniqueness Validator", "🎨", {
      instructions:
        "No repeated greetings, no repeated questions, never imply acceptance, never two identical messages anywhere in the app, exactly one warm emoji.",
    }),
    n("localize", "localize", "Local-language Localizer", "🌏"),
    n("safety", "safety", "Safety Gate", "🛡️"),
    n("deliver", "deliver", "Anti-ban Delivery Gate", "📤"),
  ];
}

const A = (of: GraphCondition[]): GraphCondition => ({ kind: "allG", of });

function e(
  id: string,
  from: string,
  to: string,
  priority: number,
  when: GraphCondition,
  label: string
): EdgeSpec {
  return { id, from, to, priority, when, enabled: true, label };
}

export function defaultGraphEdges(): EdgeSpec[] {
  return [
    // ---- sense spine ---------------------------------------------------------
    e("s-audio", "inbound", "transcribe", 10, { kind: "hasMedia", media: "audio" }, "voice note arrived"),
    e("s-text", "inbound", "extract", 20, { kind: "always" }, "read the reply"),
    e("s-transcribed", "transcribe", "extract", 10, { kind: "always" }, "transcript feeds the extractor"),
    e("s-media-check", "extract", "coherence", 10, { kind: "hasMedia", media: "any" }, "media reading needs a coherence check"),
    e("s-no-media", "extract", "comparator", 20, { kind: "always" }, "text-only reply"),
    e("s-checked", "coherence", "comparator", 10, { kind: "always" }, "coherence verdict attached"),
    e("s-think", "comparator", "director", 10, { kind: "always" }, "numbers ready - the Director thinks"),

    // ---- the Director's legal moves (priority = the discipline order) ---------
    e("d-silent-closed", "director", "silent", 10, { kind: "sessionClosed" }, "closed session stays silent"),
    e(
      "d-close-deal",
      "director",
      "closing-message",
      12,
      { kind: "eventIs", event: "user-close-deal" },
      "the traveller locked this deal"
    ),
    e(
      "d-pickup-share",
      "director",
      "pickup-location",
      14,
      A([{ kind: "eventIs", event: "user-consent-pickup" }, { kind: "pickupConsentGiven" }]),
      "traveller approved sharing their location"
    ),
    e(
      "d-answer",
      "director",
      "answer",
      20,
      A([{ kind: "shopAskedQuestion" }, { kind: "counterBelow", counter: "answer", max: 2 }]),
      "answer the shop's question"
    ),
    e(
      "d-thank-photo",
      "director",
      "answer",
      30,
      A([
        { kind: "shopSentVehiclePhoto" },
        { kind: "hasUsablePrice", value: false },
        { kind: "counterBelow", counter: "answer", max: 2 },
      ]),
      "thank the shop for the vehicle photo"
    ),
    e(
      "d-media-confirm",
      "director",
      "clarify",
      35,
      A([{ kind: "mediaCoherent", value: false }, { kind: "counterBelow", counter: "clarify", max: 2 }]),
      "media reading looks off - confirm in text"
    ),
    e(
      "d-clarify",
      "director",
      "clarify",
      40,
      A([
        { kind: "hasUsablePrice", value: false },
        { kind: "verified", value: false },
        { kind: "hasClarifyMessage" },
        { kind: "counterBelow", counter: "clarify", max: 1 },
      ]),
      "clarify once when no price yet"
    ),
    e(
      "d-bargain",
      "director",
      "bargain",
      50,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "priceAtOrBelowFloor", value: false },
        { kind: "targetIsRealSaving", value: true },
        { kind: "roundsBelow" }, // settings.maxRoundsPerShop
        { kind: "notG", of: { kind: "firmCountAtLeast", min: 2 } },
        { kind: "notG", of: { kind: "toneDegraded" } },
      ]),
      "push toward the floor (round-aware)"
    ),
    e(
      "d-deposit-probe",
      "director",
      "deposit-probe",
      54,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "fieldKnown", field: "deposit", value: false },
        { kind: "nodeRanBelow", nodeId: "deposit-probe", max: 2 },
      ]),
      "price is settling - learn the deposit"
    ),
    e(
      "d-cash-push",
      "director",
      "deposit-probe",
      56,
      A([
        { kind: "depositPassportOnly" },
        { kind: "notG", of: { kind: "cashAlternativeAskedAlready" } },
        { kind: "nodeRanBelow", nodeId: "deposit-probe", max: 3 },
      ]),
      "passport-only - ask nicely for cash instead"
    ),
    e(
      "d-fulfillment-probe",
      "director",
      "fulfillment-probe",
      58,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "fieldKnown", field: "fulfillment", value: false },
        { kind: "nodeRanBelow", nodeId: "fulfillment-probe", max: 2 },
      ]),
      "learn delivery / pickup / on-shop"
    ),
    e(
      "d-present",
      "director",
      "present",
      62,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "dealComplete", value: true },
        { kind: "nodeRanBelow", nodeId: "present", max: 1 },
      ]),
      "price + deposit + fulfillment known - show the traveller"
    ),
    e(
      "d-close-great",
      "director",
      "close",
      64,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "counterBelow", counter: "bargain", max: 1 },
        { kind: "priceAtOrBelowFloor", value: true },
        { kind: "counterBelow", counter: "close", max: 1 },
      ]),
      "close warmly on an at/below-floor price"
    ),
    e(
      "d-silent-great",
      "director",
      "silent",
      66,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "counterBelow", counter: "bargain", max: 1 },
        { kind: "priceAtOrBelowFloor", value: true },
      ]),
      "great price already thanked - stay silent"
    ),
    e(
      "d-close-no-saving",
      "director",
      "close",
      68,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "counterBelow", counter: "bargain", max: 1 },
        { kind: "priceAtOrBelowFloor", value: false },
        { kind: "targetIsRealSaving", value: false },
        { kind: "counterBelow", counter: "close", max: 1 },
      ]),
      "no genuine saving possible - close warmly"
    ),
    e(
      "d-silent-no-saving",
      "director",
      "silent",
      70,
      A([
        { kind: "hasUsablePrice", value: true },
        { kind: "matchesSpecNotFalse" },
        { kind: "counterBelow", counter: "bargain", max: 1 },
        { kind: "priceAtOrBelowFloor", value: false },
        { kind: "targetIsRealSaving", value: false },
      ]),
      "no saving and already thanked - silence"
    ),
    e(
      "d-close-after-push",
      "director",
      "close",
      80,
      A([
        { kind: "counterAtLeast", counter: "bargain", min: 1 },
        { kind: "counterBelow", counter: "close", max: 1 },
      ]),
      "thank once after our asks"
    ),

    // ---- the tail every composed message flows through ------------------------
    e("t-style", "bargain", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-a", "answer", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-c", "clarify", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-d", "deposit-probe", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-f", "fulfillment-probe", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-cl", "close", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-pl", "pickup-location", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-style-cm", "closing-message", "style-validator", 10, { kind: "always" }, "style + uniqueness"),
    e("t-localize", "style-validator", "localize", 10, { kind: "always" }, "local language stickiness"),
    e("t-safety", "localize", "safety", 10, { kind: "always" }, "content safety"),
    e("t-deliver", "safety", "deliver", 10, { kind: "always" }, "anti-ban gate + human pacing"),
    // present loops back to the Director (it composes nothing itself).
    e("t-present-back", "present", "director", 10, { kind: "always" }, "deal shown - anything else owed?"),
  ];
}

export function defaultGraphSpec(): GraphSpec {
  return {
    version: GRAPH_SPEC_VERSION,
    nodes: defaultGraphNodes(),
    edges: defaultGraphEdges(),
    settings: defaultGraphSettings(),
  };
}

/**
 * The direction the DETERMINISTIC director would pick (first legal edge from
 * `director` by priority, honoring node enablement + maxRuns). Pure - the same
 * logic the engine uses, exposed for the parity tests and the Studio replay
 * preview. Returns the target node's kind, or "silent" when nothing is legal.
 */
export function pickDirectorDirection(spec: GraphSpec, facts: GraphFacts): string {
  const nodesById = new Map(spec.nodes.map((x) => [x.id, x]));
  const legal = spec.edges
    .filter((edge) => edge.enabled && edge.from === "director")
    .filter((edge) => {
      const node = nodesById.get(edge.to);
      if (!node || !node.enabled) return false;
      if (node.maxRunsPerThread != null && (facts.nodeRuns[node.id] ?? 0) >= node.maxRunsPerThread) {
        return false;
      }
      return evalGraphCondition(edge.when, facts);
    })
    .sort((a, b) => a.priority - b.priority);
  if (legal.length === 0) return "silent";
  return nodesById.get(legal[0].to)?.kind ?? "silent";
}

// ---------------------------------------------------------------------------
// Legacy conversion - an owner's customized decision_graph carries over
// ---------------------------------------------------------------------------

const DIRECTION_NODE: Record<string, string> = {
  clarify: "clarify",
  answer: "answer",
  bargain: "bargain",
  close: "close",
  silent: "silent",
};

/**
 * Convert legacy BranchRules (the old flat ladder) into director edges. Used
 * once at migration time when the owner had CUSTOMIZED the old graph - their
 * enable/disable/order/label edits survive into the new world.
 */
export function graphFromDecisionRules(rules: BranchRule[]): EdgeSpec[] {
  return rules
    .filter((r) => r && DIRECTION_NODE[r.then?.direction])
    .map((r) => ({
      id: `legacy-${r.id}`,
      from: "director",
      to: DIRECTION_NODE[r.then.direction],
      priority: r.order,
      when: r.when as GraphCondition,
      enabled: r.enabled,
      label: r.label,
    }));
}

// ---------------------------------------------------------------------------
// Validation - a bad owner edit degrades quiet, never loud
// ---------------------------------------------------------------------------

export interface GraphValidation {
  ok: boolean;
  problems: string[];
}

export function validateGraphSpec(spec: GraphSpec): GraphValidation {
  const problems: string[] = [];
  const ids = new Set(spec.nodes.map((x) => x.id));
  if (!ids.has("director")) problems.push("the graph must keep a director node");
  if (!ids.has("deliver")) problems.push("the graph must keep a deliver node");
  if (!ids.has("extract")) problems.push("the graph must keep an extract node");
  for (const edge of spec.edges) {
    if (edge.from !== "inbound" && !ids.has(edge.from)) {
      problems.push(`edge ${edge.id} starts at unknown node "${edge.from}"`);
    }
    if (!ids.has(edge.to)) problems.push(`edge ${edge.id} points at unknown node "${edge.to}"`);
  }
  // The director must have at least one enabled outgoing edge.
  const directorOut = spec.edges.filter((x) => x.from === "director" && x.enabled);
  if (directorOut.length === 0) problems.push("the director has no enabled moves");
  // Every act node that composes text should reach the deliver gate.
  const enabledEdges = spec.edges.filter((x) => x.enabled);
  const reach = (from: string, seen = new Set<string>()): boolean => {
    if (from === "deliver") return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return enabledEdges.some((x) => x.from === from && reach(x.to, seen));
  };
  const composers = ["answer", "clarify", "bargain", "deposit-probe", "fulfillment-probe", "close"];
  for (const c of composers) {
    const node = spec.nodes.find((x) => x.id === c);
    if (node?.enabled && !reach(c)) {
      problems.push(`"${node.label}" cannot reach the deliver gate - its messages would vanish`);
    }
  }
  if (!Number.isFinite(spec.settings.maxStepsPerEvent) || spec.settings.maxStepsPerEvent < 2) {
    problems.push("maxStepsPerEvent must be at least 2");
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Sanitizer for owner-saved specs (mirror of the orchestrator route's rules)
// ---------------------------------------------------------------------------

export function sanitizeGraphSpec(raw: GraphSpec): GraphSpec {
  const def = defaultGraphSpec();
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
  };
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((x) => x && typeof x.id === "string" && typeof x.kind === "string")
    .slice(0, 60)
    .map((x) => ({
      id: x.id.slice(0, 40),
      kind: x.kind,
      label: String(x.label ?? x.id).slice(0, 80),
      emoji: typeof x.emoji === "string" ? x.emoji.slice(0, 8) : undefined,
      enabled: Boolean(x.enabled),
      instructions: String(x.instructions ?? "").slice(0, 1200),
      maxRunsPerThread:
        x.maxRunsPerThread != null ? clampInt(x.maxRunsPerThread, 0, 20, 2) : undefined,
      custom: Boolean(x.custom),
      promptTemplate:
        typeof x.promptTemplate === "string" ? x.promptTemplate.slice(0, 4000) : undefined,
    })) as NodeSpec[];
  // Built-in nodes the save is missing come back with defaults (an old copy
  // never breaks a new pipeline stage - same pattern as orchestrator config).
  for (const d of def.nodes) if (!nodes.some((x) => x.id === d.id)) nodes.push(d);

  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((x) => x && typeof x.id === "string" && typeof x.from === "string" && typeof x.to === "string" && x.when)
    .slice(0, 200)
    .map((x) => ({
      id: x.id.slice(0, 40),
      from: x.from.slice(0, 40),
      to: x.to.slice(0, 40),
      priority: clampInt(x.priority, 0, 10_000, 100),
      when: x.when,
      enabled: Boolean(x.enabled),
      label: typeof x.label === "string" ? x.label.slice(0, 120) : undefined,
    })) as EdgeSpec[];
  for (const d of def.edges) if (!edges.some((x) => x.id === d.id)) edges.push(d);

  const s = raw.settings ?? def.settings;
  const settings: GraphSettings = {
    maxStepsPerEvent: clampInt(s.maxStepsPerEvent, 2, 20, def.settings.maxStepsPerEvent),
    maxLlmCallsPerEvent: clampInt(s.maxLlmCallsPerEvent, 1, 12, def.settings.maxLlmCallsPerEvent),
    maxRoundsPerShop: clampInt(s.maxRoundsPerShop, 1, 6, def.settings.maxRoundsPerShop),
    waitWindow: {
      minS: clampInt(s.waitWindow?.minS, 10, 3600, def.settings.waitWindow.minS),
      maxS: clampInt(s.waitWindow?.maxS, 30, 7200, def.settings.waitWindow.maxS),
    },
    strategicWaitMaxMin: clampInt(s.strategicWaitMaxMin, 1, 240, def.settings.strategicWaitMaxMin),
    emojiTone: Boolean(s.emojiTone ?? def.settings.emojiTone),
    judgeSampleRate: Math.min(1, Math.max(0, Number(s.judgeSampleRate ?? 1) || 0)),
    lowEnglish: Boolean(s.lowEnglish ?? def.settings.lowEnglish),
    streetLocal: Boolean(s.streetLocal ?? def.settings.streetLocal),
  };
  return { version: GRAPH_SPEC_VERSION, nodes, edges, settings };
}
