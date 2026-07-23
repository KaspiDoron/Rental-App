// SPTE public surface (V2-4). The Single-Pass Turn Engine: Blackboard +
// single-pass agent that replaces the graph director/edge branching. See
// V2-BLUEPRINT.md section 4. Gated behind ENGINE_V3 during the dual-run; the
// graph engine remains the live path + rollback until golden parity is proven.

export * from "./types";
export { legalMovesFor, reflexTurn, coerceToLegal } from "./policy";
export { runSinglePass, pickRoute, fallbackArtifact } from "./pass";
export { runPostRails } from "./rails";
export { mergeDigest, emptyDigest } from "./digest";
export { runTurn, type TurnOutcome } from "./orchestrator";

/** Owner kill switch for the dual-run: SPTE only takes a turn when ON. */
export async function engineV3Enabled(): Promise<boolean> {
  try {
    const { getConfig } = await import("../runtime-config");
    return (await getConfig("ENGINE_V3")) === "on";
  } catch {
    return false;
  }
}
