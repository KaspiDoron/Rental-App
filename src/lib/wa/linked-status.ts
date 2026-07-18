// Pure predicate behind evolution.ts's isLinkedForUi (extracted so it is unit
// testable without pulling in the server-only evolution module).
//
// `stored` is the value from storedStatus: the actual session status string,
// "unknown" when the store is unreachable, or null when the user genuinely has
// no session row.
//   "open"       -> linked (durably paired)
//   "unknown"    -> linked (fail SAFE - a DB blip must never re-link a paired user)
//   "connecting" -> NOT linked (pairing handed out a code but the socket never opened)
//   null / other -> NOT linked
//
// The bug this guards: hasSessionRow returned true for ANY row including a
// not-yet-opened "connecting" one, so /api/wa/status reported connected=true on
// the first 3s poll of a first-time pairing - clearing the code before the user
// could enter it and stranding them "linked but never open".
export function isLinkedFromStatus(stored: string | null): boolean {
  return stored === "open" || stored === "unknown";
}
