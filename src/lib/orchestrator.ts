// The Agent Orchestrator - the owner-controlled multi-agent pipeline behind
// every WhatsApp conversation.
//
// Instead of one hardcoded ladder, each reply now flows through SPECIALIZED
// agents, each with one job in the search session:
//   opener     - the first RFQ message per shop
//   reply      - responding while there is no price yet (clarify / answer)
//   price      - responding after a price arrived (bargain direction / close)
//   validator  - reads the WHOLE thread and vetoes/repairs any draft that is
//                irrelevant, repetitive (a mid-thread "hey"), already answered,
//                or implies a deal was accepted
//   strategist - reads ALL threads in the SAME search session; cross-shop
//                leverage ("another shop offered 180") and reply TIMING (may
//                deliberately WAIT instead of replying instantly)
//
// Every stage is owner-editable (instructions, on/off, order), owners can add
// custom agents and "when X -> then Y" edge rules, and EVERY decision writes a
// full per-stage trace (input -> reasoning -> output) to agent_traces.
//
// Discipline is layered, never replaced: the deterministic ladder in
// agent-loop.ts still computes what is ALLOWED (ask once, never above the
// quote, never imply acceptance, session-closed silence). The LLM stages can
// only pick within those bounds - with no AI key everything degrades to the
// exact deterministic behavior that shipped before.

import "server-only";
import { randomBytes } from "crypto";
import { getConfig, setConfig, sbInsert } from "./runtime-config";
import { chat, extractJson } from "./ai";
import { defaultDecisionGraph, type DecisionGraph } from "./branching";
import { isLowEnglish } from "./locale";
// W4.7: ONE definition of "this message opens with a greeting", in
// copy/greeting.ts, shared with the send-time choke point
// (wa-guard.humanizeForOutbound). The local copy that used to live below was
// English-only, mangled "Hi again!" into "Again! ..." and had no right
// boundary, so "Hitting the road" lost its first two letters.
import { hasLeadingGreeting, stripLeadingGreeting } from "./copy/greeting";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StageConfig {
  id: string; // "opener" | "reply" | "price" | "validator" | "strategist" | custom
  label: string;
  enabled: boolean;
  order: number;
  instructions: string; // owner-editable, appended to the built-in stage prompt
  custom?: boolean; // owner-created advisory agent (joins the drafting prompt)
}

export interface EdgeRule {
  id: string;
  when: string; // "the shop offers a different model than we asked"
  then: string; // "politely restate our exact vehicle and ask its price once"
  enabled: boolean;
}

export interface OrchestratorConfig {
  version: 1;
  thinkIterations: number; // draft -> critique -> revise passes (min 3 honored)
  waitWindow: { minS: number; maxS: number }; // strategist hold bounds
  lowEnglish: boolean; // simple-register English in developing countries
  streetLocal: boolean; // casual register for local-language output
  stages: StageConfig[];
  rules: EdgeRule[];
}

export function defaultOrchestratorConfig(): OrchestratorConfig {
  return {
    version: 1,
    thinkIterations: 3,
    waitWindow: { minS: 120, maxS: 900 },
    lowEnglish: true,
    streetLocal: true,
    stages: [
      {
        id: "opener",
        label: "Opener - first message to a shop",
        enabled: true,
        order: 1,
        instructions:
          "Sound like a real traveller typing on their phone. One short message: " +
          "what vehicle, how many days, ask their best daily price. Nothing formal.",
      },
      {
        id: "reply",
        label: "Reply agent - no price yet (clarify / answer questions)",
        enabled: true,
        order: 2,
        instructions:
          "Answer EXACTLY what the shop asked, one short sentence, using only the " +
          "facts of the request. Never re-ask something already answered in the thread.",
      },
      {
        id: "price",
        label: "Price agent - a price arrived (bargain / close)",
        enabled: true,
        order: 3,
        instructions:
          "One friendly ask at the target price, easy to say yes to. If another shop " +
          "gave a lower real offer, mention it naturally. Never push twice, never " +
          "ask above their quote, never sound entitled.",
      },
      {
        id: "validator",
        label: "Validator - reads the whole thread before anything sends",
        enabled: true,
        order: 4,
        instructions:
          "Veto or repair: repeated greetings mid-conversation, questions the shop " +
          "already answered, anything irrelevant to the thread, any hint that a deal " +
          "is accepted or a booking confirmed (only the traveller decides), and any " +
          "language switch away from the thread's language.",
      },
      {
        id: "strategist",
        label: "Strategist - the whole search session at once",
        enabled: true,
        order: 5,
        instructions:
          "Think across every shop in this search. Use a lower rival offer as " +
          "leverage. You may WAIT before replying when patience reads more human or " +
          "other shops are about to answer - shops are not owed an instant reply.",
      },
    ],
    rules: [
      {
        id: "r-different-model",
        when: "the shop offers a different vehicle than we asked for",
        then: "politely restate our exact vehicle and dates and ask its price once",
        enabled: true,
      },
      {
        id: "r-visit-shop",
        when: "the shop says come to the shop / we'll talk in person",
        then: "ask once for a rough daily price so we know it fits the budget; if they refuse, thank them and stop",
        enabled: true,
      },
    ],
  };
}

const CONFIG_KEY = "orchestrator_config";

export async function getOrchestratorConfig(): Promise<OrchestratorConfig> {
  try {
    const raw = await getConfig(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OrchestratorConfig;
      if (parsed?.version === 1 && Array.isArray(parsed.stages)) {
        // Merge: built-in stages the owner's copy is missing come back with
        // defaults, so an old saved config never breaks a new pipeline stage.
        const def = defaultOrchestratorConfig();
        for (const d of def.stages) {
          if (!parsed.stages.some((s) => s.id === d.id)) parsed.stages.push(d);
        }
        if (!Array.isArray(parsed.rules)) parsed.rules = def.rules;
        return parsed;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return defaultOrchestratorConfig();
}

export async function saveOrchestratorConfig(cfg: OrchestratorConfig): Promise<void> {
  await setConfig(CONFIG_KEY, JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// Decision graph (the branching engine's owner-editable rules) - loaded/saved
// with the same override-or-default pattern. The pure engine lives in
// ./branching; these are the only Supabase-backed accessors.
// ---------------------------------------------------------------------------

const GRAPH_KEY = "decision_graph";

export async function getDecisionGraph(): Promise<DecisionGraph> {
  const def = defaultDecisionGraph();
  try {
    const raw = await getConfig(GRAPH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DecisionGraph;
      if (parsed?.version === 1 && Array.isArray(parsed.rules)) {
        // Merge: any NEW built-in rule the owner's saved copy lacks comes back
        // with its default, so a pipeline upgrade never drops a branch.
        for (const d of def.rules) {
          if (!parsed.rules.some((r) => r.id === d.id)) parsed.rules.push(d);
        }
        return parsed;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return def;
}

export async function saveDecisionGraph(graph: DecisionGraph): Promise<void> {
  await setConfig(GRAPH_KEY, JSON.stringify(graph));
}

export function stageOf(cfg: OrchestratorConfig, id: string): StageConfig | undefined {
  return cfg.stages.find((s) => s.id === id);
}

function stageEnabled(cfg: OrchestratorConfig, id: string): boolean {
  const s = stageOf(cfg, id);
  return s ? s.enabled : true;
}

// ---------------------------------------------------------------------------
// Language register
// ---------------------------------------------------------------------------

// Low-English is decided by COUNTRY first (region label), then currency - so
// USD-quoting ESL markets like Cambodia still get the simple register. The
// currency/country tables live in ./locale (single source of truth).
export function isLowEnglishRegion(currency?: string, region?: string): boolean {
  return isLowEnglish(region, currency);
}

/** Register directives appended to every drafting prompt. */
export function registerRules(
  cfg: OrchestratorConfig,
  currency?: string,
  region?: string
): string {
  const parts: string[] = [];
  // ANTI-FINGERPRINTING PERSONA - applies to EVERY composed message. Shops that
  // get messaged by many travellers cluster senders by their language signature;
  // this makes each message read like a different fast-typing human on a phone.
  parts.push(
    "HUMAN PERSONA (write like a real traveller texting on WhatsApp, NEVER a bot): " +
      "1) NO sign-offs - never 'Cheers', 'Best regards', 'Kind regards', 'Sincerely', " +
      "'Looking forward to hearing from you' or any polite closing line. Just stop " +
      "when the point is made. " +
      "2) SHORT and snappy - one or two quick lines, not a paragraph. It is fine to " +
      "sound a little blunt or rushed. " +
      "3) Casual, slightly imperfect expat/backpacker English - contractions, lower-case " +
      "starts, dropped words ('any cheaper?', 'can do 250?'), the odd missing apostrophe. " +
      "Never corporate, never a full formal sentence when a fragment works. " +
      "4) VARY everything - a different opening, phrasing and structure every single time; " +
      "two shops must never get the same-shaped message. " +
      "5) At most ONE emoji, and not every message - warm casual ones only (👍 🤙 🙏 😊), " +
      "never decorative rows of them. " +
      "6) Never restate who you are or re-introduce yourself mid-thread."
  );
  if (cfg.lowEnglish && isLowEnglishRegion(currency, region)) {
    parts.push(
      "LANGUAGE REGISTER: write SIMPLE, low-level English that a local shop " +
        "owner instantly understands - short words, short sentences, like " +
        "'I want rent 125cc scooter 3 days, what your best price?'. NEVER " +
        "formal phrasing like 'may I know your best competitive price'."
    );
  }
  return parts.join(" ");
}

/** Owner edge rules + custom advisory agents, folded into drafting prompts. */
export function ownerDirectives(cfg: OrchestratorConfig, stageId: string): string {
  const parts: string[] = [];
  const stage = stageOf(cfg, stageId);
  if (stage?.enabled && stage.instructions.trim()) {
    parts.push(`OWNER INSTRUCTIONS FOR THIS STEP: ${stage.instructions.trim()}`);
  }
  const rules = cfg.rules.filter((r) => r.enabled && r.when.trim() && r.then.trim());
  if (rules.length) {
    parts.push(
      "OWNER EDGE RULES (apply when the situation matches):\n" +
        rules.map((r) => `- When ${r.when.trim()}: ${r.then.trim()}`).join("\n")
    );
  }
  const customs = cfg.stages.filter((s) => s.custom && s.enabled && s.instructions.trim());
  for (const c of customs) parts.push(`${c.label.toUpperCase()}: ${c.instructions.trim()}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Traces - 100% visibility into every decision
// ---------------------------------------------------------------------------

export interface TraceRow {
  decisionId: string;
  userEmail?: string;
  vendorId?: string;
  vendorName?: string;
  stage: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string;
  // Digraph engine (v2): the exact graph node + edge that produced this row, so
  // the Pipeline Studio replays the traversed path 1:1. Optional - legacy rows
  // (and the old pipeline) leave them null and still render as a list.
  nodeId?: string;
  edgeId?: string;
  // Milliseconds spent since the previous stage - per-stage latency, persisted
  // for the Ops Center's execution timeline (falls back silently pre-migration).
  ms?: number;
}

export function newDecisionId(): string {
  return randomBytes(8).toString("hex");
}

export async function writeTrace(rows: TraceRow[]): Promise<void> {
  if (!rows.length) return;
  // Active behavior revision (policy_versions.id) stamps every decision so the
  // Ops Center can split quality metrics by "which version produced this".
  let specRev: number | null = null;
  try {
    const { getActiveRev } = await import("./ops/rev");
    specRev = await getActiveRev();
  } catch {
    /* stamps are best-effort */
  }
  const full = rows.map((r) => ({
    decision_id: r.decisionId,
    user_email: r.userEmail ?? null,
    vendor_id: r.vendorId ?? "",
    vendor_name: r.vendorName ?? "",
    stage: r.stage,
    input: r.input.slice(0, 2000),
    reasoning: r.reasoning.slice(0, 2000),
    output: r.output.slice(0, 1000),
    verdict: r.verdict ?? null,
    node_id: r.nodeId ?? null,
    edge_id: r.edgeId ?? null,
    ms: typeof r.ms === "number" && Number.isFinite(r.ms) ? Math.round(r.ms) : null,
    spec_rev: specRev,
  }));
  // sbInsert fails SILENTLY on an unknown column, so a pending migration must
  // never make the whole trace vanish. Degrade in steps: full row -> without
  // the Ops columns (ms/spec_rev) -> without the graph path columns too -
  // same graceful-degradation pattern as vendor_replies.
  const ok = await sbInsert("agent_traces", full).catch(() => false);
  if (ok === false) {
    const noOps = full.map(({ ms: _m, spec_rev: _s, ...rest }) => rest);
    const ok2 = await sbInsert("agent_traces", noOps).catch(() => false);
    if (ok2 === false) {
      await sbInsert(
        "agent_traces",
        noOps.map(({ node_id: _n, edge_id: _e, ...rest }) => rest)
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Strategist - session-wide thinking + reply timing
// ---------------------------------------------------------------------------

export interface StrategistInput {
  cfg: OrchestratorConfig;
  history: string; // this shop's thread
  sessionDigest: string; // one line per shop in THIS search session
  shopMessage: string;
  // What the deterministic ladder decided/allows - the strategist may only
  // keep it, hold it (wait), or drop to silence. It can never unlock an
  // action the discipline counters forbid.
  ladderDirection: "clarify" | "answer" | "bargain" | "close" | "silent";
  quotedPerDay?: number;
  targetPerDay?: number;
  rivalPerDay?: number;
  currency?: string;
}

export interface StrategistDecision {
  action: "reply-now" | "wait" | "silent";
  direction: StrategistInput["ladderDirection"];
  waitSeconds?: number;
  leverageNote?: string;
  reasoning: string;
  fromAi: boolean;
}

export async function runStrategist(inp: StrategistInput): Promise<StrategistDecision> {
  const fallback: StrategistDecision = {
    action: "reply-now",
    direction: inp.ladderDirection,
    reasoning: "deterministic ladder (no AI available or strategist disabled)",
    fromAi: false,
  };
  if (!stageEnabled(inp.cfg, "strategist") || inp.ladderDirection === "silent") {
    return { ...fallback, action: inp.ladderDirection === "silent" ? "silent" : "reply-now" };
  }

  const stage = stageOf(inp.cfg, "strategist");
  const system =
    "You are the negotiation strategist for a traveller renting a vehicle. You " +
    "see EVERY shop conversation in the current search session and decide how to " +
    "handle ONE shop's new message. The tactical move has already been chosen " +
    `("${inp.ladderDirection}") by hard discipline rules you can NEVER override - ` +
    "you may only keep it now, delay it (wait), or drop to silence. Waiting is a " +
    "human move: nobody answers every shop within seconds. " +
    (stage?.instructions ? `Owner guidance: ${stage.instructions} ` : "") +
    'Reply ONLY as JSON: { "action": "reply-now"|"wait"|"silent", "waitSeconds": number, ' +
    '"leverageNote": string, "reasoning": string }. leverageNote: if a LOWER real ' +
    "offer from another shop in this session should be mentioned to this shop, " +
    'describe it in a few words (e.g. "another shop offered 180/day"), else empty. ' +
    "reasoning: one or two short sentences.";
  const user =
    `THIS SEARCH SESSION (all shops):\n${inp.sessionDigest || "(only this shop so far)"}\n\n` +
    `THIS SHOP's thread:\n${inp.history}\n\n` +
    `Shop's new message: ${inp.shopMessage}\n\n` +
    `Planned move: ${inp.ladderDirection}` +
    (inp.quotedPerDay ? ` (they quoted ${inp.quotedPerDay} ${inp.currency ?? ""}/day` : "") +
    (inp.targetPerDay ? `, our target ${inp.targetPerDay}` : "") +
    (inp.rivalPerDay ? `, best rival offer ${inp.rivalPerDay}` : "") +
    (inp.quotedPerDay ? ")" : "");

  const out = await chat([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  if (!out) return fallback;
  const parsed = extractJson<{
    action?: string;
    waitSeconds?: number;
    leverageNote?: string;
    reasoning?: string;
  }>(out);
  if (!parsed) return fallback;

  const action =
    parsed.action === "wait" ? "wait" : parsed.action === "silent" ? "silent" : "reply-now";
  const { minS, maxS } = inp.cfg.waitWindow;
  const waitSeconds =
    action === "wait"
      ? Math.min(Math.max(Number(parsed.waitSeconds) || minS, minS), maxS)
      : undefined;
  return {
    action,
    direction: inp.ladderDirection,
    waitSeconds,
    leverageNote: (parsed.leverageNote ?? "").trim().slice(0, 160) || undefined,
    reasoning: (parsed.reasoning ?? "").trim().slice(0, 500) || "strategist gave no reasoning",
    fromAi: true,
  };
}

// ---------------------------------------------------------------------------
// Validator - the critique/revise iterations before anything sends
// ---------------------------------------------------------------------------

/** Deterministic repair: a mid-conversation message never greets again. */
export function stripGreeting(text: string): string {
  return stripLeadingGreeting(text);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface ValidationResult {
  verdict: "ok" | "revised" | "veto";
  text: string;
  reasons: string[];
  fromAi: boolean;
}

export async function validateDraft(args: {
  cfg: OrchestratorConfig;
  history: string;
  draft: string;
  shopMessage: string;
  priorOutbound: string[]; // our earlier messages in this thread
  currency?: string;
}): Promise<ValidationResult> {
  let text = args.draft;
  const reasons: string[] = [];

  // Deterministic layer ALWAYS runs (also the no-AI fallback):
  // 1. never greet again mid-thread
  if (args.priorOutbound.length > 0 && hasLeadingGreeting(text)) {
    text = stripGreeting(text);
    reasons.push("stripped repeated greeting mid-conversation");
  }
  // 2. never send a near-duplicate of something we already sent
  const nd = norm(text);
  if (args.priorOutbound.some((p) => norm(p) === nd)) {
    return {
      verdict: "veto",
      text: "",
      reasons: [...reasons, "draft repeats an earlier message word-for-word"],
      fromAi: false,
    };
  }

  if (!stageEnabled(args.cfg, "validator")) {
    return { verdict: reasons.length ? "revised" : "ok", text, reasons, fromAi: false };
  }

  const stage = stageOf(args.cfg, "validator");
  const system =
    "You review ONE draft WhatsApp message from a traveller to a rental shop " +
    "before it is sent. Read the whole conversation. The draft must: directly fit " +
    "the shop's last message; never repeat a question the shop already answered; " +
    "never greet again mid-conversation; NEVER imply a deal is accepted or a " +
    "booking confirmed (only the traveller decides); stay in the same language " +
    "the conversation is already in; sound like a casual human, not a bot. " +
    "PRESERVE NEGOTIATION LEVERAGE: a cited rival offer ('another shop quoted 220'), " +
    "the rental length ('for 3 days'), and a commitment-framed ask ('I'd book with " +
    "you if you can do 200') are DELIBERATE bargaining moves, not clutter and not an " +
    "accepted deal - keep them word-for-word intact in any revision. " +
    (stage?.instructions ? `Owner guidance: ${stage.instructions} ` : "") +
    (registerRules(args.cfg, args.currency) || "") +
    ' Reply ONLY as JSON: { "verdict": "ok"|"revise"|"veto", "revised": string, ' +
    '"reasons": string[] }. Use "revise" with a corrected message when the draft ' +
    'is fixable, "veto" only when no message should be sent at all.';
  const user =
    `Conversation so far:\n${args.history}\n\n` +
    `Shop's last message: ${args.shopMessage}\n\nDraft reply: ${text}`;

  const out = await chat([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  if (!out) return { verdict: reasons.length ? "revised" : "ok", text, reasons, fromAi: false };
  const parsed = extractJson<{ verdict?: string; revised?: string; reasons?: string[] }>(out);
  if (!parsed) return { verdict: reasons.length ? "revised" : "ok", text, reasons, fromAi: false };

  const aiReasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((r) => typeof r === "string").slice(0, 5)
    : [];
  if (parsed.verdict === "veto") {
    return { verdict: "veto", text: "", reasons: [...reasons, ...aiReasons], fromAi: true };
  }
  if (parsed.verdict === "revise" && typeof parsed.revised === "string" && parsed.revised.trim()) {
    let revised = parsed.revised.trim().slice(0, 400);
    if (args.priorOutbound.length > 0) revised = stripGreeting(revised);
    return {
      verdict: "revised",
      text: revised,
      reasons: [...reasons, ...aiReasons],
      fromAi: true,
    };
  }
  return { verdict: reasons.length ? "revised" : "ok", text, reasons: [...reasons, ...aiReasons], fromAi: true };
}

// ---------------------------------------------------------------------------
// Session digest - what the strategist reads
// ---------------------------------------------------------------------------

/** One line per shop this user is talking to in the current session window. */
export async function sessionDigestFor(
  senderEmail: string,
  excludeVendorId?: string
): Promise<string> {
  const { sbSelect } = await import("./runtime-config");
  const since = new Date(Date.now() - 18 * 3600_000).toISOString();
  const offers = await sbSelect<{
    vendor_id: string;
    vendor_name: string;
    price_per_day: number;
    currency: string;
    created_at: string;
  }>(
    "offers",
    `select=vendor_id,vendor_name,price_per_day,currency,created_at&user_email=eq.${encodeURIComponent(
      senderEmail
    )}&simulated=eq.false&created_at=gte.${encodeURIComponent(
      since
    )}&order=created_at.desc&limit=12`
  ).catch(() => []);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const o of offers) {
    if (seen.has(o.vendor_id)) continue;
    seen.add(o.vendor_id);
    const self = o.vendor_id === excludeVendorId ? " (THIS shop)" : "";
    lines.push(`- ${o.vendor_name || o.vendor_id}: quoted ${o.price_per_day} ${o.currency}/day${self}`);
  }
  return lines.slice(0, 8).join("\n");
}
