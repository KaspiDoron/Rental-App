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
  // ONE STEP SAID EVERYTHING ABOUT THE WHOLE START OF THE FUNNEL (W-6).
  //
  // `SEARCH_INPUT` covered every pre-search state at once - nothing typed, a
  // request with no stay, a stay with no request, and a form that is genuinely
  // ready to send. Will's advice was the same in all four, which is why it read
  // as irrelevant: three quarters of the time it named a step the traveller had
  // already taken. These are derived from the actual inputs, not from a phase
  // enum that cannot see them.
  | "SEARCH_EMPTY" // linked, nothing entered at all
  | "SEARCH_NEEDS_STAY" // a request, but no stay pinned - discovery has no origin
  | "SEARCH_NEEDS_REQUEST" // a stay, but no vehicle described
  | "SEARCH_READY" // everything present - the only step that says "press it"
  | "SEARCH_INPUT" // fallback when the inputs are not reported (legacy callers)
  | "AGENTS_DISPATCHED" // profiling / discovering / first messages going out
  // SHOPS FOUND, NOTHING SENT (owner report 3, item 9). `NEGOTIATING` fired on
  // `vendorCount > 0` alone - and since discovery finds shops without sending
  // anything, "Shops are reading your request... See it live" was the DEFAULT
  // state after every search, with zero messages out and nothing to see live.
  // The status panel on the same screen truthfully said 0 contacted; Will
  // contradicted it. The honest advice here is pick shops / ask for a price /
  // narrow with filters - the actions that MAKE something to see live.
  | "SHOPS_FOUND"
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
  /**
   * THE INPUTS WILL COULD NOT SEE.
   *
   * The guidance catalogue was keyed on a six-value enum whose only sources
   * were waConnected/phase/vendorCount/offerCount/closing - so it was
   * structurally unable to say anything about the request the traveller had
   * actually typed, whether they had set a stay, or what the local rate is.
   * Optional so existing callers keep working and simply fall back to the old
   * lumped `SEARCH_INPUT`.
   */
  hasRequest?: boolean;
  hasStay?: boolean;
  /** The consent tick is a real, common blocker with a one-tap fix. */
  idpDeclared?: boolean;
  /**
   * Shops actually CONTACTED (messaged + replied + queued + offers - the
   * status panel's own arithmetic, so the two surfaces cannot disagree).
   * Optional for the same reason as the inputs above: a caller that does not
   * report it keeps the old lumped NEGOTIATING and is never told its board is
   * untouched when it simply cannot see the board.
   */
  contactedCount?: number;
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
  if (s.phase === "profiling" || s.phase === "discovering" || s.phase === "running") {
    return "AGENTS_DISPATCHED";
  }
  if (s.vendorCount > 0) {
    // Found is not contacted. Discovery fills the board without sending a
    // single message, so "shops found" and "messages out" are different
    // states with different honest advice - collapsing them told travellers
    // to "see it live" when nothing was live. A caller that does not report
    // contactedCount keeps the old lumped NEGOTIATING.
    if (s.contactedCount === 0) return "SHOPS_FOUND";
    return "NEGOTIATING";
  }

  // Pre-search. Only refine when the caller actually reported the inputs -
  // a legacy caller that reports none must not be told its form is empty.
  const reported = s.hasRequest !== undefined || s.hasStay !== undefined;
  if (!reported) return "SEARCH_INPUT";
  if (!s.hasRequest && !s.hasStay) return "SEARCH_EMPTY";
  // Ordered by what BLOCKS: discovery cannot run without an origin at all,
  // whereas a missing request only means the profiler has less to work with.
  if (!s.hasStay) return "SEARCH_NEEDS_STAY";
  if (!s.hasRequest) return "SEARCH_NEEDS_REQUEST";
  return "SEARCH_READY";
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
