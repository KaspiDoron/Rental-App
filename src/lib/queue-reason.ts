// Honest, user-facing explanations for queued messages. The anti-ban guard
// stores its REAL reason with every wa_outbox row ("human pacing gap",
// "hourly cap reached", "shop is closed now"...). The UI must translate that
// faithfully - a pacing hold shown as "shop is closed" is a lie the user can
// disprove by looking at the shop's door (which is exactly how this bug was
// caught). Isomorphic + pure so cards, queue lists and APIs share one truth.

export type QueueReasonKind =
  | "closed"
  | "pacing"
  | "batch"
  | "sync"
  | "capacity"
  | "awaiting-replies"
  | "disconnected"
  | "tomorrow"
  | "breaker"
  | "limit"
  | "paused"
  | "hold"
  | "unknown";

export function classifyQueueReason(raw?: string | null): QueueReasonKind {
  const r = (raw ?? "").toLowerCase();
  if (!r) return "unknown";
  if (/closed|business hours/.test(r)) return "closed";
  if (/paused by you/.test(r)) return "paused";
  if (/batch-spacing/.test(r)) return "batch";
  // Transient infrastructure holds all resume on their own: fail-closed
  // sync retries, a reconnecting WhatsApp link, and per-recipient retries.
  if (/sync-retry|reconnecting|couldn't reach this shop/.test(r)) return "sync";
  // THE LINK IS DOWN - the one hold the traveller must ACT on, and the one that
  // rendered as the blank default. Owner report 8 wave A parks every automated
  // send for 30-40 minutes when `wa_sessions.status` is "close", with a reason
  // string that matched none of the twelve branches here, so the most
  // action-requiring state in the guard read "Queued - sends automatically" with
  // an ETA it could never keep: nothing sends until the user re-pairs, so the
  // clock was a promise about an event no clock controls. Tested first because
  // a dead link outranks every other explanation for a wait.
  if (/link is disconnected|re-pair|reconnect it/.test(r)) return "disconnected";
  // WAITING ON A SHOP, NOT ON A CLOCK - and it must be tested BEFORE the
  // capacity branch, because it is a different promise. The introductions
  // budget is the minimum of four ceilings; only the plan window genuinely
  // "refreshes soon". When what is binding is the count of introductions that
  // nobody has answered, nothing refreshes until a shop writes back (or the
  // oldest silent one turns seven days old). Announcing that as capacity is how
  // a traveller ends up believing the app is quietly working on shops it is
  // not.
  // ...and matched on the FULL introHoldReason wording, not a prefix. The loose
  // /waiting on replies/ also captured the guard's cold-lane string "waiting on
  // replies before opening more conversations" - a fixed six-hour freeze after a
  // WhatsApp error ack, which no reply clears. That hold was rendering as "the
  // next shop opens as soon as one answers" plus "every reply frees a slot
  // immediately": a false, checkable promise, where before it had simply said
  // nothing. Two different waits should never share a sentence.
  if (/waiting on replies - a new shop opens|shops already messaged answers/.test(r))
    return "awaiting-replies";
  if (/ceiling on shops that never replied|new-shop ceiling/.test(r)) return "limit";
  // Rolling-window introductions budget: capacity refreshes continuously.
  if (/introductions full|refreshes soon|refreshes in/.test(r)) return "capacity";
  if (/daily introductions|resumes next morning/.test(r)) return "tomorrow";
  // The circuit breakers protect the number itself. They used to fall
  // through to "unknown" and render as a blank "Queued - sends
  // automatically" - the single most consequential hold in the guard,
  // invisible. (This is the copy the 05:38 incident's queued rows showed.)
  if (/circuit breaker|-rate breaker|cold outreach frozen/.test(r)) return "breaker";
  if (/director hold|thinking time|human reply pacing/.test(r)) return "hold";
  if (/pacing|burst|gap/.test(r)) return "pacing";
  // "allowance" is how the drain words the daily/hourly send cap ("held - daily
  // message allowance reached, resumes 14:32"). It matched none of the words
  // above, so THE cap hold - the one the anti-ban budget exists to produce -
  // fell through to "unknown" and rendered as a blank "Queued - sends
  // automatically", the same silence the circuit breakers were rescued from.
  if (/cap|limit|allowance|paused|recovery|warm/.test(r)) return "limit";
  return "unknown";
}

/**
 * WHY the wait, in the traveller's terms - one sentence, for the surfaces that
 * have room for it.
 *
 * The short label says WHAT is happening. When a first message is being held
 * overnight, "what" is not enough: the traveller sees a shop sitting untouched
 * until tomorrow morning and reasonably concludes the app is broken or slow.
 * The reason is genuinely good and costs them nothing, so it should be said.
 */
export function queueReasonWhy(raw?: string | null): string | null {
  switch (classifyQueueReason(raw)) {
    case "closed":
      return (
        "This shop is closed right now. A first message sent at 3am is still " +
        "read at 9am - it only makes your number look automated, which is what " +
        "gets WhatsApp numbers restricted. Shops already talking to you are " +
        "answered immediately, day or night."
      );
    case "tomorrow":
      return (
        "You have used today's batch of NEW shops. Conversations already open " +
        "keep running normally - only first messages wait."
      );
    case "capacity":
      return (
        "Your plan opens new shops in batches, so your number stays under " +
        "WhatsApp's radar. Shops already replying are unaffected."
      );
    case "disconnected":
      return (
        "Your phone's WhatsApp link to this app has dropped - WhatsApp ends a "
        + "linked session after a while, and it can also be ended from your "
        + "phone. Nothing is lost: your messages are waiting, and they go out "
        + "as soon as you reconnect. Your agent deliberately will not retry the "
        + "connection on its own, because repeatedly re-registering a device is "
        + "exactly what gets a number restricted."
      );
    case "awaiting-replies":
      return (
        "Several shops you have already messaged have not written back yet. " +
        "A pile of unanswered first messages is the pattern WhatsApp restricts " +
        "numbers for, so your agent waits for one of them to answer before " +
        "opening another shop. Every reply frees a slot immediately."
      );
    case "breaker":
      return (
        "WhatsApp pushed back on this number, so first messages pause while it " +
        "settles. Replies to shops that wrote to you still go out."
      );
    default:
      return null;
  }
}

/** Short label for card badges and queue rows. */
export function queueReasonLabel(raw?: string | null): string {
  switch (classifyQueueReason(raw)) {
    case "closed":
      return "Waiting for the shop to open - sends automatically";
    case "paused":
      return "Paused by you - resumes when you say so";
    case "hold":
      return "Your agent is timing this reply like a human";
    case "batch":
      return "In line - your agent messages shops one at a time, like a person";
    case "sync":
      return "Queued - sending resumes automatically in a few minutes";
    case "capacity":
      return "You've reached your plan's batch of new shops - more open up shortly, automatically";
    case "disconnected":
      return "Your WhatsApp link dropped - reconnect it in Profile and these send automatically";
    case "awaiting-replies":
      return "Waiting on replies - the next shop opens as soon as one answers";
    case "tomorrow":
      return "Today's introductions are done - this goes out tomorrow morning automatically";
    case "breaker":
      return "Protecting your WhatsApp number - new-shop messages resume automatically in a few hours";
    case "pacing":
      return "Queued briefly - sends are paced like a human";
    case "limit":
      return "Done for now - sending resumes automatically later today";
    default:
      return "Queued - sends automatically";
  }
}

/** "sends in ~3 min" / "sends in ~2 h" - honest ETA from not_before. A row that
 * is already due does NOT claim "any moment" (the drain still paces it): it says
 * so honestly. */
export function queueEta(notBefore?: string | null, reason?: string | null): string {
  // AN ETA IS A PROMISE, AND ONE HOLD CANNOT KEEP IT. A disconnected link is
  // parked 30-40 minutes at a time, but nothing sends at the end of that -
  // it re-parks, indefinitely, until a HUMAN re-pairs. Rendering "sends in
  // ~35 min" there is the app inventing a deadline for an event no clock
  // controls, next to a label whose whole job is to say "you must act". The
  // suppression lives here rather than in the card so every surface that
  // learns to show an ETA inherits it.
  if (reason !== undefined && classifyQueueReason(reason) === "disconnected") return "";
  if (!notBefore) return "";
  const ms = Date.parse(notBefore) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "sending at the next safe slot";
  if (ms <= 45_000) return "sends any moment now";
  const min = Math.round(ms / 60_000);
  if (min < 90) return `sends in ~${min} min`;
  return `sends in ~${Math.round(min / 60)} h`;
}

/** A clock-time range "~10:20-10:25" (collapsed to one time when equal), for the
 * server-simulated [etaFrom, etaTo] envelope. Pure; caller supplies the clock
 * formatter so this stays free of locale/import deps. */
export function queueEtaRange(
  etaFrom: string | null | undefined,
  etaTo: string | null | undefined,
  fmt: (iso: string) => string
): string {
  if (!etaFrom) return "";
  const a = fmt(etaFrom);
  const b = etaTo ? fmt(etaTo) : a;
  return a === b ? `~${a}` : `~${a}-${b}`;
}
