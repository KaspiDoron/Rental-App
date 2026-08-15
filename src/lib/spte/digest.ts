// SPTE memory consolidation / context compression: the rolling ThreadDigest
// absorbs the conversation so history never accumulates in the prompt. Each
// turn the single pass returns <=3 new durable facts; these merge in, oldest
// evicted past a cap. This is what keeps 10 threads x 15 messages inside a lean
// per-turn token budget.

import type {
  ConfirmSubject,
  PendingConfirm,
  ThreadDigest,
  TurnArtifact,
  VerifiedExtraction,
} from "./types";

const MAX_FACTS = 10;

/**
 * HOW LONG A THREAD MAY WAIT ON AN ANSWER IT ASKED FOR.
 *
 * The owner's doctrine has two halves - ask when unsure, and WAIT for the reply
 * - and the second half needs a bound or a shop that never answers freezes the
 * negotiation forever. Turns, not minutes, because turns are what this engine
 * counts: an inbound message, a scheduled tick and a swarm poke each spend one.
 * Three is enough to survive the wakeup a paused thread schedules for itself
 * plus a couple of unrelated messages, and short enough that a silent shop is
 * released the same day.
 *
 * Durable, like the wait itself: an in-memory counter would reset on every cold
 * start, which on serverless means "never expires" or "expires at random".
 */
export const CONFIRM_WAIT_TURNS = 3;

/**
 * ...AND HOW LONG A DOUBT MAY SIT UNASKED.
 *
 * A flagged subject blocks the fact from reading as known, so a doubt the engine
 * never gets around to asking about would deadlock the thread just as surely.
 * The model picks the MOVE, so `confirm` being legal is not a guarantee it is
 * chosen; this is the escape hatch, and it releases the subject WITHOUT ever
 * claiming the shop confirmed anything (see the fact written on expiry).
 */
export const CONFIRM_OPEN_TURNS = 3;

export function emptyDigest(): ThreadDigest {
  return { facts: [], round: 0 };
}

/**
 * THE HALF OF THE DIGEST THAT IS DURABLE.
 *
 * Everything else on ThreadDigest (firmCount, depositKnown, options, the
 * ledger, lastOutbound) is RE-DERIVED from the thread's own rows every turn -
 * "the conversation is the state" - so persisting it would only create stale
 * copies that can disagree with the messages. These five cannot be derived:
 * the model's durable notes, the quote a shop gave and never restated, how many
 * times we pushed, the tone we read, and which confirming questions we have
 * already spent. They are what `buildDigest` seeds from.
 */
export function persistableDigest(d: ThreadDigest): Partial<ThreadDigest> {
  return {
    facts: d.facts.slice(-MAX_FACTS),
    ...(typeof d.quotedPricePerDay === "number" ? { quotedPricePerDay: d.quotedPricePerDay } : {}),
    round: d.round,
    ...(d.tone ? { tone: d.tone } : {}),
    ...(d.confirmAsked?.length ? { confirmAsked: d.confirmAsked } : {}),
    ...(d.awaitingConfirmation ? { awaitingConfirmation: d.awaitingConfirmation } : {}),
    // THE DOUBTS THEMSELVES. Derived state is deliberately not persisted here -
    // but a doubt is not derivable: the message that caused it scrolls into
    // history and the regexes that read that history are exactly the ones that
    // cannot see the ambiguity. Persist it or "unsure" evaporates on the next
    // turn, which is the bug this field exists for.
    ...(d.pending?.length ? { pending: d.pending } : {}),
    // The once-ever price-watch bound (owner report 5 #9). Durable or it is not
    // a bound at all - an in-memory flag would re-arm on every cold start.
    ...(d.priceWatchArmed ? { priceWatchArmed: true } : {}),
  };
}

/** Read a stored digest back, defensively - the column is free-form JSON that
 *  older rows do not have at all. */
export function digestFromStored(stored: unknown): ThreadDigest {
  const base = emptyDigest();
  const s = (stored ?? null) as Partial<ThreadDigest> | null;
  if (!s || typeof s !== "object") return base;
  return {
    ...base,
    facts: Array.isArray(s.facts) ? s.facts.filter((f) => typeof f === "string").slice(-MAX_FACTS) : [],
    quotedPricePerDay:
      typeof s.quotedPricePerDay === "number" && s.quotedPricePerDay > 0
        ? s.quotedPricePerDay
        : undefined,
    round: typeof s.round === "number" && s.round >= 0 ? s.round : 0,
    tone: s.tone,
    confirmAsked: Array.isArray(s.confirmAsked)
      ? (s.confirmAsked.filter((x) => typeof x === "string") as ConfirmSubject[])
      : undefined,
    awaitingConfirmation:
      s.awaitingConfirmation && typeof s.awaitingConfirmation === "object"
        ? s.awaitingConfirmation
        : null,
    // ABSENT means not armed, so a row written before this field existed reads
    // as "no watch yet" rather than as a watch that already happened.
    priceWatchArmed: s.priceWatchArmed === true ? true : undefined,
    // A ROW WRITTEN BEFORE `pending` EXISTED still knows it was waiting on
    // something - `awaitingConfirmation` is the card's mirror of exactly that -
    // so it is migrated forward rather than dropped. Threads mid-question at
    // deploy time keep waiting instead of quietly resuming without an answer.
    pending: pendingFromStored(s.pending) ?? pendingFromAwaiting(s.awaitingConfirmation),
  };
}

function pendingFromAwaiting(a: ThreadDigest["awaitingConfirmation"]): PendingConfirm[] | undefined {
  if (!a || typeof a !== "object" || typeof a.question !== "string" || !a.question.trim()) {
    return undefined;
  }
  return [{ subject: a.subject, question: a.question, state: "waiting", turns: 0 }];
}

/** The doubts, read back defensively - free-form JSON older rows do not have. */
function pendingFromStored(stored: unknown): PendingConfirm[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const out: PendingConfirm[] = [];
  for (const raw of stored) {
    const p = raw as Partial<PendingConfirm> | null;
    if (!p || typeof p !== "object" || typeof p.subject !== "string") continue;
    if (typeof p.question !== "string" || !p.question.trim()) continue;
    out.push({
      subject: p.subject as ConfirmSubject,
      ...(typeof p.reading === "string" ? { reading: p.reading } : {}),
      question: p.question,
      ...(typeof p.confidence === "number" ? { confidence: p.confidence } : {}),
      // A row whose state is missing reads as WAITING, the conservative side:
      // it holds the thread rather than letting an unconfirmed reading through.
      state: p.state === "open" ? "open" : "waiting",
      turns: typeof p.turns === "number" && p.turns >= 0 ? Math.floor(p.turns) : 0,
    });
  }
  return out.length ? out : undefined;
}

/**
 * ONE TURN OF THE DOUBT STATE MACHINE - pure arithmetic, run before the legal
 * move set is computed.
 *
 * Deterministic code owns "are we waiting, for what, and for how long"; the
 * MODEL owns "did they answer it" and hands its verdict in as `resolved`. That
 * split is the owner's doctrine exactly: no if/else decides what a message
 * means, and no model decides how long a bound is.
 *
 * Three outcomes per doubt:
 *   - resolved   -> gone, and the fact may read as known again.
 *   - expired    -> gone, and a durable note says the shop never answered, so
 *                   nothing downstream can claim they confirmed it.
 *   - otherwise  -> carried, one turn older.
 */
export function advanceConfirmState(
  d: ThreadDigest,
  resolved: ConfirmSubject[] = []
): ThreadDigest {
  const pending = d.pending ?? [];
  if (!pending.length) return d;
  const facts = [...d.facts];
  const next: PendingConfirm[] = [];
  for (const p of pending) {
    if (resolved.includes(p.subject)) continue;
    const turns = p.turns + 1;
    const bound = p.state === "waiting" ? CONFIRM_WAIT_TURNS : CONFIRM_OPEN_TURNS;
    if (turns > bound) {
      // NOT "they confirmed it" - "we never found out". The distinction is the
      // whole point: the thread is released so it cannot deadlock, and the note
      // is what stops a later surface presenting the unconfirmed reading as the
      // shop's settled terms.
      const note = `we asked the shop to confirm the ${p.subject} and they never answered - their own words are the only terms we have`;
      if (!facts.some((f) => f.toLowerCase() === note.toLowerCase())) facts.push(note);
      continue;
    }
    next.push({ ...p, turns });
  }
  const waiting = next.find((p) => p.state === "waiting");
  return {
    ...d,
    facts: facts.slice(Math.max(0, facts.length - MAX_FACTS)),
    pending: next.length ? next : undefined,
    awaitingConfirmation: waiting
      ? { subject: waiting.subject, question: waiting.question }
      : null,
  };
}

/**
 * Merge a turn's outcome into the durable digest: append the model's fact patch,
 * fold in verified price/decline signals deterministically (never trust the LLM
 * for numbers), bump the round when we bargained, cap + evict oldest.
 */
export function mergeDigest(
  prev: ThreadDigest,
  artifact: TurnArtifact,
  verified: VerifiedExtraction
): ThreadDigest {
  const facts = [...prev.facts];
  const add = (f: string) => {
    const t = f.trim();
    if (t && !facts.some((x) => x.toLowerCase() === t.toLowerCase())) facts.push(t);
  };

  // Deterministic, verified signals first (these outrank any LLM claim).
  if (verified.found && typeof verified.pricePerDay === "number") {
    add(`quoted ${verified.pricePerDay}${verified.currency ? " " + verified.currency : ""}/day`);
  }
  if (verified.declined) add("shop declined / walked away");
  // Only a REAL mismatch. `hasClosed()` scans these facts, so writing this on a
  // merely-ambiguous reply permanently muted the thread.
  if (verified.wrongVehicle) add("shop does not offer the requested vehicle");
  if (verified.vehicleUnclear) add("which vehicle this price is for is not confirmed yet");
  for (const o of verified.options ?? []) {
    add(`option: ${o.label} at ${o.pricePerDay}${o.currency ? " " + o.currency : ""}/day`);
  }

  // A SHOP THAT SENT US ELSEWHERE IS A CLOSED THREAD TOO. Without this the
  // one-warm-goodbye rule (`hasClosed`) could not see a graceful close, so the
  // next event on the thread would offer a second goodbye.
  if (verified.deflected) add("shop pointed us elsewhere - not dealing");

  // The model's durable notes (deposit terms, condition, tone cues).
  for (const f of artifact.digestPatch) add(f);
  if (
    artifact.move === "farewell" ||
    artifact.move === "redirect-close" ||
    artifact.move === "graceful-close"
  ) {
    add("closed - one goodbye sent");
  }

  // Keep the freshest MAX_FACTS (evict oldest).
  const capped = facts.slice(Math.max(0, facts.length - MAX_FACTS));

  // THE ASK-ONCE BOUND ON THE THIRD LEDGER STATE. A confirming question is
  // legal exactly once per subject; this is the record that makes "once" mean
  // anything, and it only means anything because the digest is now persisted.
  const confirmSubject = artifact.move === "confirm" ? artifact.confirmSubject : undefined;
  const confirmAsked = confirmSubject
    ? [...new Set([...(prev.confirmAsked ?? []), confirmSubject])]
    : prev.confirmAsked;

  // THE DOUBTS THIS TURN LEAVES THE THREAD WITH.
  //
  // Two writers, and neither of them is "the current frame looks fine":
  //   - the comprehension pass flags a subject -> it is carried as `open`,
  //     durably, so the next turn cannot forget the thread is unsure;
  //   - our confirming question goes out -> that subject flips to `waiting`,
  //     and the thread waits (policy.ts holds the moves down to silence).
  //
  // Nothing here CLEARS a doubt. Clearing is a judgement about what the shop's
  // reply meant, which belongs to the model (advanceConfirmState's `resolved`),
  // or to the turn bound. This function used to clear the wait whenever the
  // current message carried no uncertainty - which is true of every scheduled
  // tick, so the agent asked its question and then bargained without the answer.
  const pending: PendingConfirm[] = (prev.pending ?? []).map((p) => ({ ...p }));
  for (const u of verified.uncertain ?? []) {
    const seen = pending.find((p) => p.subject === u.subject);
    if (seen) {
      // The same doubt, restated: keep the state machine's clock, refresh the
      // words. A shop repeating an ambiguous answer does not buy a fresh wait.
      seen.reading = u.reading || seen.reading;
      seen.question = u.question?.trim() || seen.question;
      seen.confidence = u.confidence;
      continue;
    }
    if (!u.question?.trim()) continue;
    pending.push({
      subject: u.subject,
      reading: u.reading,
      question: u.question,
      confidence: u.confidence,
      state: "open",
      turns: 0,
    });
  }
  if (confirmSubject) {
    const question =
      (verified.uncertain ?? []).find((u) => u.subject === confirmSubject)?.question ??
      pending.find((p) => p.subject === confirmSubject)?.question ??
      artifact.message ??
      "";
    const seen = pending.find((p) => p.subject === confirmSubject);
    if (seen) {
      seen.state = "waiting";
      seen.turns = 0;
      seen.question = question || seen.question;
    } else {
      pending.push({ subject: confirmSubject, question, state: "waiting", turns: 0 });
    }
  }

  // WHAT THE CARD SAYS WHILE WE WAIT - a mirror of the state machine, never a
  // second opinion about it.
  const waiting = pending.find((p) => p.state === "waiting");
  const awaitingConfirmation = waiting
    ? { subject: waiting.subject, question: waiting.question }
    : null;

  return {
    facts: capped,
    quotedPricePerDay:
      verified.found && typeof verified.pricePerDay === "number"
        ? verified.pricePerDay
        : prev.quotedPricePerDay,
    round: prev.round + (artifact.move === "bargain" ? 1 : 0),
    tone: prev.tone,
    confirmAsked,
    awaitingConfirmation,
    pending: pending.length ? pending : undefined,
  };
}
