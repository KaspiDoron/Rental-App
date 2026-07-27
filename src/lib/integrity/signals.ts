// PLATFORM INTEGRITY, GRADUATED - and never an automatic block.
//
// The rule the owner wants enforced is real: the free plan arranges same-day
// rentals, and a traveller who uses the app to find and negotiate a shop, then
// steps outside it to arrange tomorrow directly, has taken the paid feature
// without the plan. But the enforcement that existed was one regex over ONE
// message and an immediate six-hour block:
//
//     if (requestsFuturePickup(message)) setCooldown(email, 360)
//
// One phrase - "maybe next week I'll come back", "my flight is tomorrow" - and
// a paying-nothing-yet traveller lost the product for the rest of their day,
// with no warning, no explanation they could act on, and nobody to appeal to.
// The owner's instruction was explicit: be careful, we do not want to block
// users just like that for no good reason.
//
// The missing capability was EVIDENCE THAT ACCUMULATES AND DECAYS. One phrase
// is a signal, not a verdict. Several signals across a short window, each with
// its own evidence, is a pattern - and even then the last rung is a PROPOSAL
// the owner approves, not an action the system takes on its own.
//
// The ladder:
//     nudge          - the composer explains the plan rule, nothing is blocked
//     soft cooldown  - a short pause on automated sends, clearly explained
//     feature limit  - custom messages pause; the agents keep negotiating
//     block proposal - queued for the owner in Ops, WITH the evidence
//
// Signals decay on their own, so a false positive costs a traveller a sentence
// of explanation rather than an account. Nothing here is destructive and
// nothing is silent.
//
// PURE core (this file has no clock and no database of its own) so the ladder
// is testable and the thresholds are visible in one place.

export type SignalKind =
  | "future-pickup" // arranging a day the plan does not cover
  | "contact-exchange" // swapping numbers/handles to continue elsewhere
  | "off-platform-invite"; // "message me directly", "add me on ..."

export interface IntegritySignal {
  kind: SignalKind;
  /** When it happened (epoch ms). */
  at: number;
  /** The words that produced it, trimmed - so any action can be explained. */
  evidence: string;
}

export type IntegrityStep = "clear" | "nudge" | "cooldown" | "limit" | "propose-block";

export interface IntegrityVerdict {
  step: IntegrityStep;
  /** How many signals are still live after decay. */
  score: number;
  /** Plain-language message for the traveller. Never accusatory. */
  message?: string;
  /** Minutes of pause, when the step is a pause at all. */
  pauseMinutes?: number;
  /** The evidence behind the verdict, for the traveller and for Ops. */
  evidence: string[];
}

/** A signal older than this no longer counts. Long enough to see a pattern,
 *  short enough that a bad day does not follow someone around. */
export const SIGNAL_TTL_MS = 48 * 3600_000;

/**
 * Rungs. Deliberately gentle at the bottom and human-approved at the top.
 *
 * `pauseMinutes` is the ONLY thing that makes a rung restrictive, and callers
 * gate on it rather than on the step name - so "which rungs block?" is answered
 * by this table and nowhere else. The top rung carries the same two-hour pause
 * as the one below it because a proposal is not a punishment: the traveller
 * waits out a pause while the owner reads the evidence, and only an approved
 * decision (lib/integrity/adjudication) can restrict them for longer.
 */
export const LADDER: Array<{ atScore: number; step: IntegrityStep; pauseMinutes?: number }> = [
  { atScore: 1, step: "nudge" },
  { atScore: 3, step: "cooldown", pauseMinutes: 30 },
  { atScore: 5, step: "limit", pauseMinutes: 120 },
  { atScore: 7, step: "propose-block", pauseMinutes: 120 },
];

// ---- detection -------------------------------------------------------------

const FUTURE_PICKUP =
  /\b(tomorrow|next day|day after|the following day|in \d+ days?|next week|on (mon|tues|wednes|thurs|fri|satur|sun)day|pick ?up (on|next|tomorrow)|deliver (tomorrow|next)|book for (tomorrow|the \d))\b/i;

const CONTACT_EXCHANGE =
  /(\+?\d[\d\s().-]{8,}\d)|\b(whatsapp me|my number is|here'?s my number|save my number)\b/i;

const OFF_PLATFORM =
  /\b(message me (directly|privately)|contact me (directly|on)|add me on|let'?s (talk|continue) (on|in) (whatsapp|line|telegram|instagram|messenger)|outside the app|deal directly)\b/i;

/**
 * Signals in ONE message. A message can raise more than one, and each carries
 * its own evidence so a later action can say exactly what it is based on.
 *
 * Note what is deliberately NOT here: quoting a shop's own words back, or
 * discussing a future date in the abstract, cannot be told apart from the real
 * thing in a single message - which is precisely why one message never decides
 * anything on its own.
 */
export function signalsIn(text: string, atMs: number): IntegritySignal[] {
  const s = String(text ?? "");
  const out: IntegritySignal[] = [];
  const clip = s.trim().slice(0, 180);
  if (FUTURE_PICKUP.test(s)) out.push({ kind: "future-pickup", at: atMs, evidence: clip });
  if (CONTACT_EXCHANGE.test(s)) out.push({ kind: "contact-exchange", at: atMs, evidence: clip });
  if (OFF_PLATFORM.test(s)) out.push({ kind: "off-platform-invite", at: atMs, evidence: clip });
  return out;
}

/** Signals still inside the decay window. */
export function liveSignals(signals: IntegritySignal[], nowMs: number): IntegritySignal[] {
  return signals.filter((s) => Number.isFinite(s.at) && nowMs - s.at <= SIGNAL_TTL_MS);
}

/**
 * Where on the ladder this traveller stands. Weighted, because an explicit
 * invitation to continue off-platform is stronger evidence than a mention of
 * tomorrow - but even the strongest single signal cannot reach the top rung on
 * its own, by construction.
 */
const WEIGHT: Record<SignalKind, number> = {
  "future-pickup": 1,
  "contact-exchange": 2,
  "off-platform-invite": 3,
};

export function assessIntegrity(
  signals: IntegritySignal[],
  nowMs: number,
  plan: string | null | undefined
): IntegrityVerdict {
  const live = liveSignals(signals, nowMs);
  // The rule only exists because of what the free plan does not include. A
  // paying traveller arranging next Tuesday is USING the product.
  const isFree = String(plan ?? "").toLowerCase() === "free" || !plan;
  const relevant = isFree ? live : live.filter((s) => s.kind !== "future-pickup");
  const score = relevant.reduce((n, s) => n + (WEIGHT[s.kind] ?? 1), 0);
  const evidence = relevant.map((s) => s.evidence).slice(-4);

  let rung = LADDER[0];
  let matched = false;
  for (const r of LADDER) {
    if (score >= r.atScore) {
      rung = r;
      matched = true;
    }
  }
  if (!matched || score <= 0) return { step: "clear", score, evidence };

  return {
    step: rung.step,
    score,
    pauseMinutes: rung.pauseMinutes,
    message: messageFor(rung.step, rung.pauseMinutes),
    evidence,
  };
}

/**
 * What the traveller is told. Explains the rule and the way forward; never
 * accuses, and never implies a permanent consequence the system cannot deliver.
 */
function messageFor(step: IntegrityStep, pauseMinutes?: number): string {
  switch (step) {
    case "nudge":
      return "Heads up: the free plan arranges same-day rentals. Pro and Ultra schedule pickups for a future day - everything else keeps working as normal.";
    case "cooldown":
      return `Automated sending is paused for ${pauseMinutes} minutes while future-day pickups are being arranged on a free plan. Your shops keep their place and replies still arrive.`;
    case "limit":
      return `Custom messages are paused for ${pauseMinutes} minutes - the agents carry on negotiating for you. Upgrading to Pro lifts this and unlocks future-day pickups.`;
    case "propose-block":
      return "Sending is under review. Nothing has been closed and your deals are intact - we will come back to you.";
    default:
      return "";
  }
}

/** The top rung is a PROPOSAL. Nothing here ever blocks an account by itself. */
export function requiresOwnerApproval(step: IntegrityStep): boolean {
  return step === "propose-block";
}
