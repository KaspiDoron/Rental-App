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
  if (/cap|limit|paused|recovery|warm/.test(r)) return "limit";
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
export function queueEta(notBefore?: string | null): string {
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
