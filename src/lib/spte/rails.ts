// SPTE post-rails - the DETERMINISTIC, 0-token verification every drafted
// message passes before it can be sent. This is where price integrity and the
// protocol guarantees live: the LLM proposes text, these rails dispose.
//
// Reuses the exact same guards the graph engine used (checkOutboundNumbers,
// correctDuration) so a council-composed message is held to the same standard,
// plus the never-finalize-a-time protocol rule (Step 5).

import { checkOutboundNumbers, correctDuration } from "../graph/guardrails";
import type { RailResult, TurnArtifact, TurnContext } from "./types";

// A drafted message must never AGREE a concrete pickup/delivery time - the
// traveller confirms that directly (Step 5 hard rule). These patterns catch an
// LLM that tried to lock a time.
const TIME_COMMIT_RX =
  /\b(see you|meet you|i'?ll be there|pick ?up at|come by at|let'?s meet|be there at)\b.*\b(\d{1,2}\s?(?:am|pm|:\d{2})|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TIME_DEFER_LINE = " I'll confirm the exact time with you directly.";

/**
 * Run all post-rails on a composed artifact. Returns the final wire text, or a
 * rejection the caller turns into a deterministic fallback (never a broken send).
 */
export function runPostRails(ctx: TurnContext, artifact: TurnArtifact): RailResult {
  // Silent / no-message moves have nothing to verify.
  if (artifact.move === "silent" || !artifact.message) {
    return { ok: true, finalText: undefined };
  }

  let text = artifact.message.trim();
  if (!text) return { ok: true, finalText: undefined };

  // 1) Duration integrity: rewrite any wrong day-count to the RFQ's real value.
  text = correctDuration(text, ctx.session.rfq.durationDays).text;

  // 2) Numeric integrity: fabricated-rival / below-floor / inverted-ask. The
  //    ONE real rival is the cheapest sibling offer; the ceiling is the shop's
  //    own live quote; the floor is the grounded/market floor.
  const rival = ctx.session.rivals[0]?.pricePerDay;
  const ceiling = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  const check = checkOutboundNumbers({
    text,
    ceiling,
    floor: ctx.guards.floorPerDay,
    rivalPrice: rival,
    excludeExact: [ctx.session.rfq.durationDays, ctx.session.rfq.engineSizeCc ?? 0].filter(Boolean),
    checkAskBounds: artifact.move === "bargain" || artifact.move === "momentum",
  });
  if (!check.ok) {
    // A number that fails verification is never sent (the anti-hallucination
    // guarantee). The caller falls back to a safe templated move.
    return { ok: false, rejected: { rule: check.violation ?? "numbers", detail: check.detail } };
  }

  // 3) Never finalize a time.
  if (TIME_COMMIT_RX.test(text) && !/confirm.*time/i.test(text)) {
    text = text.replace(TIME_COMMIT_RX, "").replace(/\s{2,}/g, " ").trim();
    text = `${text}${TIME_DEFER_LINE}`;
  }

  return { ok: true, finalText: text };
}
