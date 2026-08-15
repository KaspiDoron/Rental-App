// THE OWNER'S A/B, COMPILED (owner report 5 #2, second half).
//
//   "I want to measure the times of successful bargain that we suggested a
//    lower price (we gave them a specific number) Vs the times of successful
//    bargaining that we didn't gave them a specific price and just asked for a
//    lower price than X."
//
// The two arms are assigned per thread in negotiation/ask-variant and stamped
// on the `engine-v3-turn` telemetry row that composes each bargain. The
// CONCESSION is one turn later, on the row that follows in the same thread: the
// shop's next quote against the one it was on. This module joins those two
// facts and nothing else.
//
// WHY THE JOIN LIVES HERE AND NOT IN SQL. `learnFromReply` already credits the
// arm into the tactic memory, which is the LEARNING half - it moves what the
// agent does next. This is the REPORTING half, and it needs something tactic
// memory deliberately does not keep: per-arm medians and a sample count the
// owner can judge significance by. Two different questions, two readers, one
// source of truth (the telemetry rows).
//
// PURE, over rows the caller already read - the same split every ops/* module
// uses, so the rule is reviewable and testable without a database.
//
// DELIBERATELY NOT `materialDrop`. That flag means "the session's lowest price
// just improved", which can be a DIFFERENT shop entirely; using it here would
// credit this thread's phrasing for another thread's win. The signal is this
// shop's own quote moving down.

import type { AskVariant } from "../negotiation/ask-variant";

/** One turn, as the telemetry blob holds it. */
export interface VariantTurn {
  /** Thread identity - the arm is per thread, and so is the concession. */
  vendorId?: string | null;
  userEmail?: string | null;
  createdAt: string; // ISO
  move?: string | null;
  askVariant?: string | null;
  /** The counter we named, or null when we named none. */
  counterPricePerDay?: number | null;
  /** Whether the draft honoured its arm (ask-variant.variantHonoured). */
  variantOk?: boolean | null;
  /** The shop's live quote on THIS turn - the concession is read from the pair
   *  of consecutive quotes in one thread. */
  quote?: number | null;
  /** The thread's standing quote before this turn, when the composer knew one. */
  standingQuote?: number | null;
}

export interface ArmStats {
  variant: AskVariant;
  /** Bargains sent in this arm that we could score (a before and an after). */
  attempts: number;
  /** How many of those produced a lower quote. */
  concessions: number;
  /** concessions / attempts, 0-100, or null with no attempts. */
  successPct: number | null;
  /** Median percentage cut across the CONCEDING attempts, or null. */
  medianConcessionPct: number | null;
  /** Drafts that ignored their arm (named a number in the open-ended arm, or
   *  named none in the specific arm). A high number invalidates the read. */
  offArm: number;
}

export interface AskVariantReport {
  arms: ArmStats[];
  /** Total scored attempts across both arms - the owner's significance cue. */
  samples: number;
  /**
   * The plain-language answer, or null while the sample is too thin to have
   * one. Deliberately conservative: an A/B that reports a winner off nine
   * bargains is worse than one that says "not yet".
   */
  verdict: string | null;
}

const MIN_SAMPLES_PER_ARM = 20;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Number(((s[mid - 1] + s[mid]) / 2).toFixed(1));
}

function threadKey(t: VariantTurn): string {
  return `${String(t.userEmail ?? "")}::${String(t.vendorId ?? "")}`;
}

/**
 * Compile the report from raw turn rows (any order, any time range).
 *
 * The attribution is the same one-turn-late rule `learnFromReply` uses, and for
 * the same reason: a bargaining move's result is the shop's NEXT answer, so a
 * bargain is scored against the quote on the following turn IN THE SAME THREAD.
 * A bargain with no following turn is not a failure, it is unscored - counting
 * it as a loss would systematically punish whichever arm was sent most recently.
 */
export function compileAskVariantReport(turns: VariantTurn[]): AskVariantReport {
  const byThread = new Map<string, VariantTurn[]>();
  for (const t of turns) {
    const k = threadKey(t);
    const list = byThread.get(k) ?? [];
    list.push(t);
    byThread.set(k, list);
  }

  const acc = new Map<AskVariant, { attempts: number; wins: number; cuts: number[]; offArm: number }>();
  const bump = (v: AskVariant) =>
    acc.get(v) ?? { attempts: 0, wins: 0, cuts: [] as number[], offArm: 0 };

  for (const list of byThread.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i < list.length; i++) {
      const turn = list[i];
      if (turn.move !== "bargain") continue;
      const arm = turn.askVariant as AskVariant | undefined;
      if (arm !== "specific-number" && arm !== "open-ended-below") continue;
      const bucket = bump(arm);
      if (turn.variantOk === false) bucket.offArm += 1;

      // The price the shop was on when we pushed. Prefer the composer's own
      // standing quote (it is the number the message argued against); fall back
      // to the quote this turn read.
      const before = Number(turn.standingQuote ?? turn.quote);
      // The shop's ANSWER - the first later turn in this thread that carries a
      // quote at all.
      let after: number | undefined;
      for (let j = i + 1; j < list.length; j++) {
        const q = Number(list[j].quote ?? list[j].standingQuote);
        if (Number.isFinite(q) && q > 0) {
          after = q;
          break;
        }
      }
      if (!Number.isFinite(before) || before <= 0 || after === undefined) {
        acc.set(arm, bucket);
        continue;
      }
      // A price that went UP is not a loss for the phrasing - it is usually a
      // different vehicle or a correction (the same ruling judgeMove makes).
      if (after > before) {
        acc.set(arm, bucket);
        continue;
      }
      bucket.attempts += 1;
      if (after < before) {
        bucket.wins += 1;
        bucket.cuts.push(Number((((before - after) / before) * 100).toFixed(1)));
      }
      acc.set(arm, bucket);
    }
  }

  const arms: ArmStats[] = (["specific-number", "open-ended-below"] as AskVariant[]).map((variant) => {
    const b = acc.get(variant) ?? { attempts: 0, wins: 0, cuts: [], offArm: 0 };
    return {
      variant,
      attempts: b.attempts,
      concessions: b.wins,
      successPct: b.attempts ? Math.round((b.wins / b.attempts) * 100) : null,
      medianConcessionPct: median(b.cuts),
      offArm: b.offArm,
    };
  });

  const samples = arms.reduce((n, a) => n + a.attempts, 0);
  const [specific, open] = arms;
  let verdict: string | null = null;
  if (specific.attempts >= MIN_SAMPLES_PER_ARM && open.attempts >= MIN_SAMPLES_PER_ARM) {
    const ds = (specific.successPct ?? 0) - (open.successPct ?? 0);
    verdict =
      Math.abs(ds) < 5
        ? "No clear difference yet - both phrasings win at about the same rate."
        : ds > 0
          ? `Naming a specific number wins ${ds} points more often.`
          : `Asking open-ended ("below X") wins ${-ds} points more often.`;
  }
  return { arms, samples, verdict };
}
