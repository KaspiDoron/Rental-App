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
  if (/sync-retry/.test(r)) return "sync";
  // Rolling-window introductions budget: capacity refreshes continuously.
  if (/introductions full|refreshes soon|refreshes in/.test(r)) return "capacity";
  if (/daily introductions|resumes next morning/.test(r)) return "tomorrow";
  if (/director hold|thinking time|human reply pacing/.test(r)) return "hold";
  if (/pacing|burst|gap/.test(r)) return "pacing";
  if (/cap|limit|paused|recovery|warm/.test(r)) return "limit";
  return "unknown";
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
    case "pacing":
      return "Queued briefly - sends are paced like a human";
    case "limit":
      return "Done for now - sending resumes automatically later today";
    default:
      return "Queued - sends automatically";
  }
}

/** "sends in ~3 min" / "sends in ~2 h" - honest ETA from not_before. */
export function queueEta(notBefore?: string | null): string {
  if (!notBefore) return "";
  const ms = Date.parse(notBefore) - Date.now();
  if (!Number.isFinite(ms) || ms <= 45_000) return "sends any moment now";
  const min = Math.round(ms / 60_000);
  if (min < 90) return `sends in ~${min} min`;
  return `sends in ~${Math.round(min / 60)} h`;
}
