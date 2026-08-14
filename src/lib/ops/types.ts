// Shared types for the AI Operations Center - the owner's review console and
// the learning loop it feeds. Isomorphic (no server-only imports): the same
// shapes ride the /api/admin/ops/* wire and the ops UI components.

// ---- Owner reviews ------------------------------------------------------------

export type ReviewVerdict = "approve" | "reject";
export type OutcomeImpact = "improved" | "worsened" | "neutral";
export type ReviewStatus = "open" | "flagged" | "auto_flagged" | "resolved";
export type ReviewSource = "owner" | "auto";

/** One owner (or detector) judgment of an agent decision - agent_reviews row. */
export interface AgentReview {
  id: number;
  decision_id: string | null; // null = thread-level (e.g. detector flag)
  thread_key: string;
  user_email: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  node_id: string | null;
  edge_id: string | null;
  rating: number | null; // 1..5
  verdict: ReviewVerdict | null;
  branch_correct: boolean | null;
  outcome_impact: OutcomeImpact | null;
  better_response: string | null;
  feedback: string | null;
  tags: string[];
  bookmark: boolean;
  status: ReviewStatus;
  source: ReviewSource;
  auto_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** The writable subset the console POSTs (upserted by decision+thread). */
export interface ReviewInput {
  threadKey: string;
  decisionId?: string | null;
  rating?: number;
  verdict?: ReviewVerdict;
  branchCorrect?: boolean;
  outcomeImpact?: OutcomeImpact;
  betterResponse?: string;
  feedback?: string;
  tags?: string[];
  bookmark?: boolean;
  status?: ReviewStatus;
  /**
   * "The agent misunderstood what the shop MEANT." Every field above judges our
   * MOVE; this one judges our COMPREHENSION, which is where the live failures
   * actually start. Pins the shop message and labels it from a closed
   * vocabulary, so the correction compiles into behaviour instead of prose.
   */
  misread?: import("./misread").MisreadCorrection;
}

// ---- Versioned behavior changes -------------------------------------------------

// "ops_learning" (Wave 3): the compiled learning blob is behavior-affecting
// config, so it rides the same policy_versions machinery as the other two -
// versioned, golden-gated, rollbackable - instead of a bare setConfig write.
export type PolicyKind = "graph_spec" | "policy_overlay" | "ops_learning";

export interface PolicyVersion {
  id: number;
  kind: PolicyKind;
  version: number;
  spec: unknown;
  note: string | null;
  author: string | null;
  replay_score: ReplayReport | null;
  active: boolean;
  created_at: string;
}

// ---- Golden replay cases ---------------------------------------------------------

/** One frozen shop turn: everything the engine needs, no live LLM/network. */
export interface GoldenTurn {
  shopSays: string;
  /** Frozen extraction result (what extractOffer returned at capture time). */
  stubExtraction: Record<string, unknown>;
  rivalPricePerDay?: number;
  /** Frozen sibling-shop offers - flow through the production rival predicate. */
  rivalOffers?: import("../search-session").RivalOffer[];
  imageKind?: string;
  voice?: boolean;
  /**
   * OUR message that went out BEFORE this shop turn (Wave 3). Live SPTE derives
   * the ledger, the ask-once gate and the at-floor lock from the real outbound
   * history; a frozen case that cannot carry our side of the conversation makes
   * all of those structurally untestable in the gate. Optional and additive:
   * existing cases (which lack it) replay byte-identically.
   */
  ourReplyBefore?: string;
}

/** Per-turn expectation - all fields optional, all must hold when present. */
export interface GoldenExpect {
  action?: string; // engine result.action
  edgeId?: string; // chosen director edge
  pathContains?: string[]; // node ids that must appear in the path
  targetAtLeast?: number; // lastTarget must be >= this (no deal-killing lowball)
  noMessageContains?: string[]; // banned substrings in the composed message
  /**
   * The move the PRIMARY engine (SPTE) must choose this turn. `action`/`edgeId`
   * above gate the dormant graph engine; this is what gates the one that
   * actually answers shops. Checked against replaySpteTurns.
   */
  move?: import("../spte/types").MoveKind;
  /** Moves that must NOT be chosen - e.g. a menu must never end in a goodbye. */
  moveNot?: Array<import("../spte/types").MoveKind>;
}

export interface GoldenCase {
  id: number;
  name: string;
  thread_key: string | null;
  rfq: Record<string, unknown>;
  region: string | null;
  floor: { floor?: number; typical?: number; currency?: string } | null;
  turns: GoldenTurn[];
  expects: GoldenExpect[];
  enabled: boolean;
  created_at: string;
}

/** One case's replay outcome (baseline or candidate). */
export interface ReplayCaseResult {
  caseId: number;
  name: string;
  pass: boolean;
  turns: {
    turn: number;
    shopSays?: string;
    expected: GoldenExpect;
    got: {
      action: string;
      edgeId?: string;
      path: string[];
      target?: number;
      message?: string;
      /** What the PRIMARY (SPTE) engine chose, when the case asserted a move. */
      move?: string;
      spteMessage?: string;
    };
    failures: string[];
  }[];
}

export interface ReplayReport {
  ranAt: string;
  total: number;
  passed: number;
  cases: ReplayCaseResult[];
  /**
   * Set when the golden store could not be read (Supabase outage). A report
   * carrying this is NOT a verdict: total 0 here means "unknown", not "green",
   * and every activation gate must FAIL CLOSED on it (goldenGateBlocks). This is
   * what separates "no cases exist yet" (an honest, vacuous pass) from "cases
   * exist but we could not see them" (approving blind).
   */
  storeError?: "unavailable";
  /** Honest context on a trivially-green report (e.g. "no cases exist yet"). */
  note?: string;
}

// ---- Compiled learning blob (app_config.ops_learning) ----------------------------

/**
 * Everything the live engine reads from owner feedback, PRE-COMPILED at review
 * time so the hot path costs one cached config read and zero extra queries.
 * All fields are plain text the LLM sees - the deterministic fallback and the
 * legal-edge computation never change.
 */
export interface OpsLearning {
  compiledAt: string;
  /** <=6 lines like "edge d-bargain: owner-correct 5/6, outcomes improved 4x". */
  edgePriorLines: string[];
  /** <=2 owner-approved negotiation snippets (situation -> correct move). */
  directorExemplars: string[];
  /** <=3 owner-labeled examples that re-anchor the move judge's rubric. */
  judgeCalibration: string[];
}
