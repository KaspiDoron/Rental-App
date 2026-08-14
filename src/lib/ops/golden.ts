// The golden regression suite - real conversations frozen into deterministic
// replay cases, used as the EVAL GATE for every behavior change: a candidate
// graph spec or policy overlay only activates if every enabled golden case
// still passes under it. Because replay is fully deterministic (stubbed
// extraction + frozen floor + llmAllowed:false + frozen clock), the whole
// suite runs server-side in one request with zero LLM calls.

import "server-only";
import { sbSelect } from "../runtime-config";
import { replayConversation, replaySpteTurns } from "../simulate";
import type { PlayedTurn } from "../simulate";
import type { GraphSpec } from "../graph/types";
import type { PolicyOverlay } from "./overlay";
import type { GoldenCase, GoldenExpect, ReplayCaseResult, ReplayReport } from "./types";

// 48 (owner report 4/W2.2): 24 was already tight against the owner's frozen
// conversations PLUS the authored coherence seeds below - a suite that stops
// growing stops gating.
const MAX_CASES = 48;

/** Pure expectation checker - unit-tested. */
export function evaluateTurn(
  expected: GoldenExpect | undefined,
  played: PlayedTurn,
  /** The same turn as run by the PRIMARY engine, when the case asserts a move. */
  spte?: { move: string; ourReply: string | null }
): string[] {
  if (!expected) return [];
  const failures: string[] = [];
  // PRIMARY ENGINE first: `move` is the assertion that gates production. A case
  // that asks for a move but never reached the SPTE replay is a failure, not a
  // silent pass - an eval gate that skips when it cannot check is not a gate.
  if (expected.move) {
    if (!spte) failures.push(`move: expected "${expected.move}", SPTE replay did not run`);
    else if (spte.move !== expected.move) {
      failures.push(`move: expected "${expected.move}", got "${spte.move}"`);
    }
  }
  for (const banned of expected.moveNot ?? []) {
    if (spte?.move === banned) failures.push(`move: "${banned}" is forbidden here`);
  }
  for (const banned of expected.noMessageContains ?? []) {
    if ((spte?.ourReply ?? "").toLowerCase().includes(banned.toLowerCase())) {
      failures.push(`SPTE message contains banned "${banned}"`);
    }
  }
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

export function evaluateCase(
  gc: GoldenCase,
  playedTurns: PlayedTurn[],
  spteTurns: Array<{ move: string; ourReply: string | null }> = []
): ReplayCaseResult {
  const turns = playedTurns.map((played, i) => {
    const expected = gc.expects[i] ?? {};
    const failures = evaluateTurn(expected, played, spteTurns[i]);
    return {
      turn: i,
      shopSays: played.shopSays?.slice(0, 300),
      expected,
      got: {
        action: played.action,
        edgeId: played.ladder?.find((r) => r.chosen)?.edgeId,
        path: played.path,
        target: played.state.lastTarget,
        message: (played.ourReply ?? "").slice(0, 300) || undefined,
        // What the PRIMARY engine did - so a failure report names the thing
        // that actually shipped, not just the dormant graph's action.
        move: spteTurns[i]?.move,
        spteMessage: (spteTurns[i]?.ourReply ?? "").slice(0, 300) || undefined,
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
    // Both engines replay the same frozen thread: the graph engine for the
    // action/edge assertions, SPTE - the one that actually answers shops - for
    // the move assertions. Only cases that ask for a move pay for the second.
    const wantsMove = gc.expects.some((e) => e?.move || e?.moveNot?.length || e?.noMessageContains?.length);
    const [{ turns }, spte] = await Promise.all([
      replayConversation({
        turns: gc.turns,
        rfq: gc.rfq,
        region: gc.region ?? undefined,
        floor: gc.floor,
        spec: opts.spec,
        overlay: opts.overlay,
      }),
      wantsMove
        ? replaySpteTurns({ turns: gc.turns, rfq: gc.rfq, floor: gc.floor })
        : Promise.resolve({ turns: [] as Awaited<ReturnType<typeof replaySpteTurns>>["turns"] }),
    ]);
    return evaluateCase(gc, turns, spte.turns);
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
  // The authored coherence seeds join the owner's frozen conversations in the
  // durable suite (idempotent, name-keyed - see golden-coherence.ts). A seed
  // failure never blocks the gate itself.
  try {
    const { ensureCoherenceGoldenCases } = await import("./golden-coherence");
    await ensureCoherenceGoldenCases();
  } catch {
    /* seeding is an enrichment - the gate runs on whatever is stored */
  }
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
