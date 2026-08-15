// SPTE orchestrator - the turn lifecycle that ties the modules together. This
// is the single-pass replacement for runGraphTurn: pre-rails (deterministic,
// free) -> reflex tier OR single pass (<=1 LLM call) -> post-rails
// (deterministic, free) -> digest merge + outcome. IO is injected so it runs in
// both the web and the worker runtime and is unit-testable without a DB.

import type {
  MoveKind,
  ThreadDigest,
  TurnArtifact,
  TurnContext,
  ModelRoute,
  VerifiedExtraction,
} from "./types";
import { confirmSubjectFor, legalMovesFor, reflexTurn } from "./policy";
import { runSinglePass, fallbackArtifact } from "./pass";
import { runPostRails } from "./rails";
import { mergeDigest } from "./digest";

export interface TurnOutcome {
  move: MoveKind;
  /** The wire-ready text, or undefined for a silent/no-send turn. */
  text?: string;
  /** The next durable digest to persist. */
  digest: ThreadDigest;
  /** A strategic wait, in minutes, or undefined. */
  waitMinutes?: number;
  /** True when the lowest offer for the session materially improved this turn -
   *  the caller enqueues bounded re-bargain wakeups for sibling threads. */
  materialDrop: boolean;
  route: ModelRoute;
  artifact: TurnArtifact;
  /** The verified inbound signals (for the caller to persist offers/state). */
  verified: VerifiedExtraction;
}

/**
 * Run ONE turn of the single-pass engine. Pure orchestration over the injected
 * context; performs at most ONE LLM call (0 for a reflex turn). Never throws,
 * never goes silent on a composable move, never sends an unverified number.
 */
export async function runTurn(ctx: TurnContext): Promise<TurnOutcome> {
  // PRE-RAILS: legal move set (0 tokens).
  ctx.legalMoves = legalMovesFor(ctx);

  // TIER R: reflex resolution with no LLM call. Protocol reflexes (license
  // policy) carry their exact wire text - deterministic even with every LLM
  // provider down. The text still passes the post-rails like any draft.
  const reflex = reflexTurn(ctx);
  if (reflex) {
    const artifact: TurnArtifact = {
      read: { intent: reflex.reason },
      think: reflex.reason,
      move: reflex.move,
      message: reflex.message,
      leverageUsed: [],
      digestPatch: [],
    };
    const rail = runPostRails(ctx, artifact);
    return finalize(ctx, artifact, { tier: "R", reason: "reflex" }, rail.ok ? rail.finalText : undefined);
  }

  // REPLAY: no network, no model, byte-stable. The legal move set and every
  // rail above and below are the REAL ones - only the composition is frozen,
  // which is exactly the property a regression gate needs.
  if (ctx.deterministic) {
    const fb = fallbackArtifact(ctx);
    const rail = runPostRails(ctx, fb);
    return finalize(ctx, fb, { tier: "R", reason: "replay" }, rail.ok ? rail.finalText : undefined);
  }

  // TIER F / M: the turn's ONE LLM call, schema-validated + move-coerced.
  const { artifact, route } = await runSinglePass(ctx);

  // POST-RAILS: verify numbers + protocol. A rejected draft falls back to a
  // safe templated move (never a broken send).
  const rail = runPostRails(ctx, artifact);
  if (!rail.ok) {
    const fb = fallbackArtifact(ctx);
    const fbRail = runPostRails(ctx, fb);
    return finalize(ctx, fb, { tier: "R", reason: "quota-overflow" }, fbRail.ok ? fbRail.finalText : undefined);
  }
  return finalize(ctx, artifact, route, rail.finalText);
}

function finalize(
  ctx: TurnContext,
  artifact: TurnArtifact,
  route: ModelRoute,
  finalText?: string
): TurnOutcome {
  const v = ctx.inbound.verified;
  // WHICH FACT A CONFIRM IS ABOUT is decided by the policy, never by the model:
  // the model picks the MOVE from a closed vocabulary, and the subject is
  // already determined by what the comprehension pass could not settle. Stamped
  // here so every path - reflex, replay and the single pass - records it, and
  // so the ask-once bound below cannot be sidestepped by a route.
  if (artifact.move === "confirm" && !artifact.confirmSubject) {
    artifact.confirmSubject = confirmSubjectFor(ctx)?.subject;
  }
  const digest = mergeDigest(ctx.thread.digest, artifact, v);

  // A material improvement: a fresh, lower quote than the session's current
  // lowest (or the first offer at all) -> tell the swarm.
  const priorLowest = ctx.session.lowest?.pricePerDay;
  const newQuote = v.found ? v.pricePerDay : undefined;
  const materialDrop =
    typeof newQuote === "number" &&
    (priorLowest === undefined || newQuote < priorLowest * 0.95);

  return {
    move: artifact.move,
    text: artifact.move === "silent" ? undefined : finalText,
    digest,
    waitMinutes: artifact.waitMinutes,
    materialDrop,
    route,
    artifact,
    verified: v,
  };
}
