// The golden regression suite - real conversations frozen into deterministic
// replay cases, used as the EVAL GATE for every behavior change: a candidate
// graph spec or policy overlay only activates if every enabled golden case
// still passes under it. Because replay is fully deterministic (stubbed
// extraction + frozen floor + llmAllowed:false + frozen clock), the whole
// suite runs server-side in one request with zero LLM calls.

import "server-only";
import { sbSelect } from "../runtime-config";
import { replayConversation } from "../simulate";
import type { PlayedTurn } from "../simulate";
import type { GraphSpec } from "../graph/types";
import type { PolicyOverlay } from "./overlay";
import type { GoldenCase, GoldenExpect, ReplayCaseResult, ReplayReport } from "./types";

const MAX_CASES = 24;

/** Pure expectation checker - unit-tested. */
export function evaluateTurn(
  expected: GoldenExpect | undefined,
  played: PlayedTurn
): string[] {
  if (!expected) return [];
  const failures: string[] = [];
  if (expected.action && played.action !== expected.action) {
    failures.push(`action: expected "${expected.action}", got "${played.action}"`);
  }
  if (expected.edgeId) {
    const chosen = played.ladder?.find((r) => r.chosen)?.edgeId;
    if (chosen !== expected.edgeId) {
      failures.push(`edge: expected "${expected.edgeId}", got "${chosen ?? "(none)"}"`);
    }
  }
  for (const node of expected.pathContains ?? []) {
    if (!played.path.includes(node)) failures.push(`path missing node "${node}"`);
  }
  if (typeof expected.targetAtLeast === "number") {
    const t = played.state.lastTarget;
    if (typeof t !== "number" || t < expected.targetAtLeast) {
      failures.push(`target: expected >= ${expected.targetAtLeast}, got ${t ?? "(none)"}`);
    }
  }
  for (const banned of expected.noMessageContains ?? []) {
    if ((played.ourReply ?? "").toLowerCase().includes(banned.toLowerCase())) {
      failures.push(`message contains banned "${banned}"`);
    }
  }
  return failures;
}

export function evaluateCase(gc: GoldenCase, playedTurns: PlayedTurn[]): ReplayCaseResult {
  const turns = playedTurns.map((played, i) => {
    const expected = gc.expects[i] ?? {};
    const failures = evaluateTurn(expected, played);
    return {
      turn: i,
      expected,
      got: {
        action: played.action,
        edgeId: played.ladder?.find((r) => r.chosen)?.edgeId,
        path: played.path,
        target: played.state.lastTarget,
        message: (played.ourReply ?? "").slice(0, 300) || undefined,
      },
      failures,
    };
  });
  return {
    caseId: gc.id,
    name: gc.name,
    pass: turns.every((t) => t.failures.length === 0),
    turns,
  };
}

export async function listGoldenCases(onlyEnabled = true): Promise<GoldenCase[]> {
  const filter = onlyEnabled ? "enabled=eq.true&" : "";
  return sbSelect<GoldenCase>(
    "agent_golden_cases",
    `select=*&${filter}order=created_at.desc&limit=${MAX_CASES}`
  ).catch(() => []);
}

export async function runGoldenCase(
  gc: GoldenCase,
  opts: { spec?: GraphSpec; overlay?: PolicyOverlay } = {}
): Promise<ReplayCaseResult> {
  try {
    const { turns } = await replayConversation({
      turns: gc.turns,
      rfq: gc.rfq,
      region: gc.region ?? undefined,
      floor: gc.floor,
      spec: opts.spec,
      overlay: opts.overlay,
    });
    return evaluateCase(gc, turns);
  } catch (e) {
    return {
      caseId: gc.id,
      name: gc.name,
      pass: false,
      turns: [
        {
          turn: 0,
          expected: {},
          got: { action: "error", path: [] },
          failures: [`replay crashed: ${e instanceof Error ? e.message : String(e)}`],
        },
      ],
    };
  }
}

/**
 * Run the whole enabled suite against a candidate (or the live baseline when
 * no candidate is given). This IS the eval gate: activation requires
 * report.passed === report.total. An empty suite passes trivially - the gate
 * tightens automatically as the owner freezes real conversations.
 */
export async function runGoldenSuite(
  opts: { spec?: GraphSpec; overlay?: PolicyOverlay } = {}
): Promise<ReplayReport> {
  const cases = await listGoldenCases(true);
  const results: ReplayCaseResult[] = [];
  for (const gc of cases) results.push(await runGoldenCase(gc, opts));
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    cases: results,
  };
}
