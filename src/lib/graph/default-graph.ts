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

// Bump when the shipped default node prompts / edges change in a way that
// should reach already-saved graphs. Currently informational (the sanitizer
// backfills empty prompts on every load regardless).
export const DEFAULT_GRAPH_REVISION = 2;

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
    n("inbound", "entry", "Inbound event", "📥", {
      instructions:
        "Every shop reply enters here - a text, a price-list or vehicle photo, or a voice note - and flows into the sense agents below.",
    }),
    // ---- sense ----
    n("transcribe", "transcribe", "Voice Transcriber - heavy-accent voice notes", "🎙️", {
      instructions:
        "Shop owners often reply with a voice note in a HEAVY local accent, fast and casual, mixing local words. Transcribe it EXACTLY and digit-perfect on every price, cc, and deposit number (e.g. '200 baht', '35,000 km', '3000 deposit'). Never summarise - a wrong digit becomes a wrong offer.",
    }),
    n("extract", "extract", "Offer Extractor - reads text + photos", "🔎", {
      instructions:
        "Pull the real per-day price, deposit, and how-to-get-it from the reply. A TOTAL quote divides into per-day ('900 for 3 day' = 300/day). Read price-list photos, odometer/mileage photos ('45,000 km' is mileage, NOT a price), and note vehicle condition (scratches, old vs new model). Never invent a price - only what the shop actually stated.",
    }),
    n("coherence", "media-coherence", "Media Coherence Validator", "🧿", {
      instructions:
        "After every photo or voice reading, sanity-check it against the WHOLE conversation before we act on it: does the currency scale fit (300 vs 30,000), is it the vehicle we asked for, do the numbers match earlier turns, is a mileage number being mistaken for a price? If it does not line up, flag it so we confirm in text instead of trusting a bad read.",
    }),
    n("comparator", "comparator", "Market & Rival Comparator", "⚖️", {
      instructions:
        "Anchor on the REAL local ground-floor for this exact vehicle (e.g. 150/day for a 125cc here) and push toward it. If another shop in THIS search already gave a lower real price, that is honest leverage ('I have an offer for 170 for the same bike') - use it, but NEVER invent a rival number.",
    }),
    // ---- chief ----
    n("director", "director", "Negotiation Director", "🧠", {
      instructions:
        "You see EVERY shop in the search at once and this shop's full thread. Patience is leverage: you do not owe any shop an instant reply - when a shop says 'no deal', WAIT a few minutes to see if they break before you answer, and let the shop send the last message. Push toward the real ground-floor using the cheapest rival offer as leverage. Before showing the traveller a deal you must know price + deposit + how they get the vehicle. Prefer cash deposit over passport. Stop pushing the instant the shop says last price / cannot lower, or sounds annoyed, then close warmly. Always warm, human, with a friendly 'my friend' tone and one emoji.",
    }),
    // ---- act ----
    n("answer", "answer", "Answer the shop", "💬", {
      maxRunsPerThread: 4,
      instructions:
        "Answer exactly what the shop asked in one short, casual sentence using only the real request facts - never invent, never re-ask something already answered. If they sent a photo of the actual bike/car, thank them warmly. Never accept a deal or say a price 'works' - only the traveller decides.",
    }),
    n("clarify", "clarify", "Clarify the offer", "❓", {
      maxRunsPerThread: 2,
      instructions:
        "Only when something real is still unclear (which model, is that per day, did I understand your voice message), ask ONE short, simple question a non-native shop owner instantly understands. Never a greeting - we are mid-chat.",
    }),
    n("bargain", "bargain", "Bargainer", "🥊", {
      instructions:
        "One friendly ask per round toward the ground-floor, easy to say yes to, warm and human with a 'my friend' tone and one emoji. Round 1 anchors near the floor; round 2 softens and meets closer to their new number; the final round is a tiny nudge. Use a lower rival offer as honest leverage ('I have offer 170 for same bike, can you do better?'). When they show an old/scratched bike or high mileage, use that too ('I see scratches, too old'). Never push after an explicit last price / cannot lower, or when they sound annoyed.",
    }),
    n("deposit-probe", "deposit-probe", "Deposit Negotiator", "🛂", {
      maxRunsPerThread: 3,
      instructions:
        "Always learn the deposit before the traveller sees the deal ('what deposit you need?'). We strongly prefer CASH over passport. If the shop wants passport only, ask nicely ONCE for a cash alternative ('I cannot leave my passport, I need it - can I give 3000 cash instead? 😊'). If they still insist passport-only, accept it and record it.",
    }),
    n("fulfillment-probe", "fulfillment-probe", "Fulfillment Prober", "🛵", {
      maxRunsPerThread: 2,
      instructions:
        "Learn how the traveller gets the vehicle before presenting: does the shop deliver to the hotel (free or a fee), come PICK THE TRAVELLER UP by car/bike, or is it on-shop only? Ask simply ('you deliver to my hotel, or I come to shop?').",
    }),
    n("present", "present", "Present deal to traveller", "🎁", {
      instructions:
        "No shop message - this marks the deal ready to show the traveller once price + deposit + how-to-get-it are all known, with the right tags (on shop / free delivery / pickup, and the deposit amount or passport).",
    }),
    n("close", "close", "Warm closer", "🤝", {
      maxRunsPerThread: 2,
      instructions:
        "End the exchange warmly after our asks - thank them and say we will think it over and message again. NEVER imply the deal is accepted or booked; only the traveller closes a deal. Match their tone (warm yes vs polite no).",
    }),
    n("pickup-location", "pickup-location", "Share pickup location", "📍", {
      maxRunsPerThread: 2,
      instructions:
        "Send the traveller's exact location as a maps link ONLY after they approved it on the card, and ask when the shop can come pick them up.",
    }),
    n("closing-message", "closing-message", "Deal-close messenger", "✅", {
      maxRunsPerThread: 2,
      instructions:
        "The traveller locked this deal - tell the shop warmly that we want it at the agreed price and arrange pickup/delivery, then the traveller continues in their own WhatsApp.",
    }),
    n("silent", "silent", "Deliberate silence", "🤫", {
      instructions:
        "A first-class move: sometimes the strongest play is to say nothing and let the shop send the next (or last) message. Also used when the search session is closed.",
    }),
    // ---- tail gates ----
    n("style-validator", "style-validator", "Style & Uniqueness Validator", "🎨", {
      instructions:
        "Before anything sends: no repeated greeting mid-chat, no question the shop already answered, never imply acceptance, stay in the conversation's language, and - critically at scale - NEVER send a message that matches one already sent anywhere in the app. Exactly one warm emoji.",
    }),
    n("localize", "localize", "Local-language Localizer", "🌏", {
      instructions:
        "When the thread is in the shop's local language (Ultra), rewrite the outbound natively in that language in a casual street register, and keep a faithful English gloss for the traveller. A thread that started local never flips to English.",
    }),
    n("safety", "safety", "Safety Gate", "🛡️", {
      instructions:
        "Final content screen - block anything unsafe, offensive, or that makes a promise/commitment on the traveller's behalf.",
    }),
    n("deliver", "deliver", "Anti-ban Delivery Gate", "📤", {
      instructions:
        "Human pacing (never reply in under a couple of seconds), business-hours + reputation caps, and content variance so no two sends look automated. A director 'wait' extends the delay on purpose.",
    }),
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
      { kind: "eventIs", event: "user-consent-pickup" },
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
        // ONE explicit firm signal ("last price", "cannot lower") ends the
        // price push - in the launch playbook nobody bargains past it.
        { kind: "notG", of: { kind: "firmCountAtLeast", min: 1 } },
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
  const defById = new Map(def.nodes.map((d) => [d.id, d]));
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((x) => x && typeof x.id === "string" && typeof x.kind === "string")
    .slice(0, 60)
    .map((x) => {
      const id = x.id.slice(0, 40);
      const builtin = defById.get(id);
      const savedInstr = String(x.instructions ?? "").slice(0, 1200);
      return {
        id,
        kind: x.kind,
        label: String(x.label ?? x.id).slice(0, 80),
        // A built-in node that was shipped with an empty prompt gets the rich
        // launch-ready default backfilled - so improved defaults reach an
        // already-saved production graph WITHOUT overwriting the owner's own
        // edits (a non-empty saved prompt always wins).
        emoji:
          typeof x.emoji === "string" && x.emoji ? x.emoji.slice(0, 8) : builtin?.emoji,
        enabled: Boolean(x.enabled),
        instructions: savedInstr || (builtin && !x.custom ? builtin.instructions : ""),
        maxRunsPerThread:
          x.maxRunsPerThread != null
            ? clampInt(x.maxRunsPerThread, 0, 20, 2)
            : builtin?.maxRunsPerThread,
        custom: Boolean(x.custom),
        promptTemplate:
          typeof x.promptTemplate === "string" ? x.promptTemplate.slice(0, 4000) : undefined,
      };
    }) as NodeSpec[];
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
