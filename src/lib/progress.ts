// THE TWO-SEGMENT BATCH PROGRESS BAR - plan Part 11 F4.
//
// THE LARGEST RISK IN THIS FEATURE IS THAT IT BECOMES A FIFTH NUMBER THAT
// DISAGREES WITH THE OTHER FOUR.
//
// Part 5.5's finding: there are already four live derivations of "how many
// shops have been contacted" plus a fifth dead one, and `page.tsx` renders
// `Math.max()` of two of them - the app picks which of its own numbers to
// believe at render time. A progress bar computed in the client, from a feed
// the client has already truncated, would make the worst UI defect in the app
// measurably worse and put it on the most-watched surface in the product.
//
// So this module is PURE and the bar is computed SERVER-SIDE, on the same
// `vendorStates` rollup that every card and counter already reads (the
// authoritative rung in `/api/activity`). The client renders the number it is
// given and derives nothing. That is the whole design constraint; everything
// below is arithmetic.
//
// DURATION IS NEVER A CONSTANT. Part 11 F1 established that a batch runs
// 20-25 minutes at free tier and 55-105 minutes at a full 24 shops, so a bar
// paced against a hardcoded hour would sit at 40% while a free-tier batch was
// already finished. The ETA here is the one the queue simulator computed from
// the real schedule, passed through - or absent, which renders as absent.

/** Where the bar has stopped, and why. `none` means it is moving normally. */
export type ProgressStall =
  | "none"
  /** The window's introductions budget is spent. Real, temporary, has a time. */
  | "intro-budget"
  /** Cold initiation is held. NEVER rendered in ban language - see below. */
  | "cold-held"
  /** Every shop is reached; the wait is now entirely on them. */
  | "awaiting-shops";

export interface BatchProgressInput {
  /** Shops the traveller selected that are still in play (tombstones excluded). */
  selected: number;
  /** Shops whose introduction actually reached them. */
  reached: number;
  /** Shops that have produced a priced offer. */
  quoted: number;
  /** Shops in a live conversation with no priced offer yet. */
  negotiating: number;
  /** Intro rows still sitting in the outbox. */
  queued: number;
  /** Introductions left in this window, or null when unreadable. */
  introRemaining: number | null;
  /** The sender health verdict, as the guard classified it. */
  health: "healthy" | "pacing" | "paused" | "recovering" | "disconnected" | "attention" | null;
  /** ISO time the queue simulator expects the last intro to land. */
  etaDoneBy?: string | null;
  /** ISO time the introductions window next frees a slot. */
  introNextFreeAt?: string | null;
}

export interface BatchProgress {
  /** 0-100. Monotone in every input, and never 100 while work is live. */
  pct: number;
  /** Which half of the bar is currently moving. */
  segment: 1 | 2;
  reached: number;
  selected: number;
  quoted: number;
  negotiating: number;
  stall: ProgressStall;
  /**
   * The sentence to render, WHOLE - not a number glued to a fragment.
   *
   * Part 5.3's rule: number-plus-fragment concatenation does not survive
   * Hebrew or RTL, so every string here carries its own placeholders and goes
   * through `t()` at the call site.
   */
  label: string;
  /** Placeholder values for `label`, so the caller never rebuilds the sentence. */
  vars: Record<string, string | number>;
  etaDoneBy?: string | null;
}

/**
 * Owner decision 4: the bar is two segments, and the split is 60/40.
 *
 * Segment 1 (0-60%) is "shops reached / shops selected" - exactly computable
 * and monotone from the outbox. Segment 2 (60-100%) is "quotes collected /
 * shops reached", and it deliberately keeps moving well after segment 1 fills,
 * because dispatch finishing is not the same as the price being found.
 */
export const SEGMENT_ONE_PCT = 60;

/**
 * The ceiling while anything is still in flight.
 *
 * A bar that reads 100% with a negotiation live is a lie the user can check in
 * ten seconds by opening the thread, and it is the exact class of claim Part
 * 9.6 deleted eight of.
 */
export const LIVE_CEILING_PCT = 99;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * SEGMENT 2 RESOLVES AGAINST SHOPS REACHED, NOT SHOPS SELECTED.
 *
 * This is the difference between a bar that finishes and one that hangs at 80%
 * forever. Most shops never reply; if the denominator were the selection, a
 * batch where six of ten stay silent could never pass 84% no matter how well
 * the other four went, and the user would read permanent silence as a stuck
 * app rather than as four good quotes.
 */
function quoteFraction(quoted: number, reached: number): number {
  if (reached <= 0) return 0;
  return clamp(quoted / reached, 0, 1);
}

/**
 * What is holding the bar, in priority order.
 *
 * `cold-held` outranks `intro-budget` because when both are true the health
 * hold is the one that will not clear on a clock.
 */
export function stallOf(input: BatchProgressInput): ProgressStall {
  const { queued, reached, selected, health, introRemaining } = input;
  if (queued > 0 && (health === "paused" || health === "recovering")) return "cold-held";
  // `introRemaining === null` is an unreadable budget, and an unreadable budget
  // is not evidence of a hold. Fail-dark means "say nothing", not "invent a
  // reason" - the fail-green failure this repo has shipped twice, inverted.
  if (queued > 0 && introRemaining !== null && introRemaining <= 0) return "intro-budget";
  if (queued === 0 && selected > 0 && reached >= selected) return "awaiting-shops";
  return "none";
}

/**
 * THE COPY, and constraint 5 governs every word of it.
 *
 * A restriction rendered to the traveller in ban language is a support ticket
 * and a broken trust promise; "ban", "restricted", "blocked" and "flagged"
 * belong on the linking and consent screens and nowhere else. The lint test in
 * Part 9.6 already enforces exactly that over `src/components/**`, and these
 * strings are written to pass it on their merits rather than by living in a
 * file the lint does not read.
 *
 * `cold-held`'s sentence is the one that matters: it says what is true (we are
 * waiting on replies before opening more conversations) rather than what is
 * scary, and it is true whether the hold came from a health verdict or from
 * the engagement brake.
 */
function labelFor(input: BatchProgressInput, stall: ProgressStall): {
  label: string;
  vars: Record<string, string | number>;
} {
  const { reached, selected, quoted, negotiating } = input;
  switch (stall) {
    case "cold-held":
      return {
        label: "Waiting on replies before opening more conversations - {reached} of {selected} shops reached so far.",
        vars: { reached, selected },
      };
    case "intro-budget":
      return {
        label: "Held: your number reached its message allowance for now. {reached} of {selected} shops reached, the rest resume shortly.",
        vars: { reached, selected },
      };
    case "awaiting-shops":
      return quoted > 0
        ? {
            label: "All {selected} shops reached - {quoted} have quoted, waiting on the rest.",
            vars: { selected, quoted },
          }
        : {
            label: "All {selected} shops reached - waiting for the first replies.",
            vars: { selected },
          };
    default:
      break;
  }
  if (reached < selected) {
    return {
      label: "Reaching shops - {reached} of {selected} so far.",
      vars: { reached, selected },
    };
  }
  if (negotiating > 0) {
    return {
      label: "{quoted} quotes in, {negotiating} still being negotiated.",
      vars: { quoted, negotiating },
    };
  }
  return { label: "{quoted} of {reached} shops quoted.", vars: { quoted, reached } };
}

/**
 * The bar, in one pure function.
 *
 * Every branch here is total: a zero selection, an unreadable budget and a
 * count that exceeds its own denominator all resolve rather than throw,
 * because this runs inside the activity poll and a progress bar must never be
 * the reason a poll fails.
 */
export function batchProgress(input: BatchProgressInput): BatchProgress {
  const selected = Math.max(0, Math.floor(input.selected));
  // Counts are clamped to their denominators. They come from independent reads
  // (outbox rows, the state rollup, live offers) which can disagree by one row
  // across a poll boundary - and a bar that renders 11 of 10 reads as a bug in
  // a way that a bar which quietly says 10 of 10 does not.
  const reached = clamp(Math.floor(input.reached), 0, selected);
  const quoted = clamp(Math.floor(input.quoted), 0, reached);
  const negotiating = clamp(Math.floor(input.negotiating), 0, reached);
  const queued = Math.max(0, Math.floor(input.queued));
  const normalized: BatchProgressInput = { ...input, selected, reached, quoted, negotiating, queued };

  const stall = stallOf(normalized);
  const seg1 = selected > 0 ? clamp(reached / selected, 0, 1) : 0;
  const seg2 = quoteFraction(quoted, reached);
  let pct = SEGMENT_ONE_PCT * seg1 + (100 - SEGMENT_ONE_PCT) * seg2;

  // THE BAR STOPS, WITH A REASON. It does not keep creeping on nothing while
  // the queue is frozen - a bar that advances while no message is moving is
  // the "optimistic-then-jump" ETA defect wearing a different hat.
  if (stall === "cold-held" || stall === "intro-budget") {
    pct = Math.min(pct, SEGMENT_ONE_PCT * seg1);
  }

  const live = queued > 0 || negotiating > 0 || reached < selected || quoted < reached;
  if (live) pct = Math.min(pct, LIVE_CEILING_PCT);
  if (selected === 0) pct = 0;

  const { label, vars } = labelFor(normalized, stall);
  return {
    pct: Math.round(clamp(pct, 0, 100)),
    segment: reached < selected ? 1 : 2,
    reached,
    selected,
    quoted,
    negotiating,
    stall,
    label,
    vars,
    etaDoneBy: input.etaDoneBy ?? null,
  };
}
