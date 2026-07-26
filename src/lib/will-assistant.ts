// The pure core of Will-as-concierge: which step of the funnel the user is on,
// and where a floating guidance bubble should sit relative to its anchor.
//
// Kept free of React on purpose - the step derivation and the placement math
// are the two pieces that rot silently when they live inline in a component,
// so both are unit-tested here and consumed by WillAssistantProvider /
// WillGuideOverlay.

/** The funnel, as Will narrates it. One step at a time, derived - never stored. */
export type WillStep =
  | "WA_LINK_PENDING" // WhatsApp not linked - the search is locked
  | "WA_AUTHENTICATING" // code entered / handshake verifying
  | "SEARCH_INPUT" // linked, no search yet - compose the request
  | "AGENTS_DISPATCHED" // profiling / discovering / first messages going out
  | "NEGOTIATING" // shops contacted, no prices yet
  | "RESULTS_READY"; // offers on the table (or a deal closing)

export interface WillStepInput {
  /** Tri-state link status: null = still checking (say nothing yet). */
  waConnected: boolean | null;
  /** Pairing phase from the connect screen, when it is mounted. */
  waPhase?: string | null;
  /** Search pipeline phase: idle | profiling | running | done. */
  phase: string;
  vendorCount: number;
  offerCount: number;
  closing: boolean;
}

/**
 * Map live app state onto exactly one step - or null while the link status is
 * still unknown (guidance that flashes and vanishes reads as glitchy, so while
 * checking we say nothing at all).
 */
export function deriveWillStep(s: WillStepInput): WillStep | null {
  if (s.waConnected === null) return null;
  if (s.waConnected === false) {
    return s.waPhase === "AUTHENTICATING" ? "WA_AUTHENTICATING" : "WA_LINK_PENDING";
  }
  if (s.closing || s.offerCount > 0) return "RESULTS_READY";
  if (s.phase === "profiling" || s.phase === "running") return "AGENTS_DISPATCHED";
  if (s.vendorCount > 0) return "NEGOTIATING";
  return "SEARCH_INPUT";
}

// ---------------------------------------------------------------------------
// Bubble placement - fixed-position card near an anchor rect, clamped to the
// viewport. Same philosophy as InfoTip's edge nudge: max-width clamps the
// WIDTH, never the position, so the math must keep the card on screen.
// ---------------------------------------------------------------------------

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface BubblePlacement {
  top: number;
  left: number;
  placement: "above" | "below";
  /** Arrow x-offset within the bubble, so it keeps pointing at the anchor even
   *  after the bubble was clamped sideways. */
  arrowLeft: number;
}

export function placeBubble(
  anchor: Rect,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 12
): BubblePlacement {
  const gap = 10; // breathing room between anchor and card
  const anchorCx = anchor.left + anchor.width / 2;

  // Prefer ABOVE the anchor (thumb usually covers what is below on mobile);
  // fall below only when there is no headroom.
  const fitsAbove = anchor.top - gap - bubble.height >= margin;
  const placement: "above" | "below" = fitsAbove ? "above" : "below";
  const top = fitsAbove
    ? anchor.top - gap - bubble.height
    : Math.min(anchor.top + anchor.height + gap, viewport.height - margin - bubble.height);

  // Center on the anchor, then clamp inside the viewport.
  let left = anchorCx - bubble.width / 2;
  left = Math.max(margin, Math.min(left, viewport.width - margin - bubble.width));

  // Arrow keeps pointing at the anchor center, clamped inside the card body.
  const arrowLeft = Math.max(18, Math.min(anchorCx - left, bubble.width - 18));

  return { top: Math.max(margin, top), left, placement, arrowLeft };
}

/** Ms of no interaction before the user counts as idle (hesitating). */
export const WILL_IDLE_MS = 8_000;
/** Ms in AUTHENTICATING before Will adds the "few more seconds" reassurance. */
export const WILL_SLOW_AUTH_MS = 5_000;
