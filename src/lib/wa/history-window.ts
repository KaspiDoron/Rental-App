// THE CONVERSATION THE ENGINE ACTUALLY REMEMBERS (owner report 4/W2.2).
//
// Two truncations quietly amputated long negotiations:
//
//   - The history window was "the last 12 rows". A 20-message thread lost its
//     HEAD - the RFQ and the vehicle-naming turns - which is exactly the part
//     that anchors what "it", "that one" and a bare "350" refer to. The model
//     then re-asked things the shop answered on message two.
//   - The line builder read `body` only, so a voice note rendered as the
//     string "[voice note]": the transcript that drove the turn it arrived on
//     VANISHED from every later turn's context. A price the shop only ever
//     SPOKE did not exist one turn later.
//
// This is the one line/window builder for both engines. Character-budgeted
// (a token proxy, same discipline as the coalescer): when the thread fits,
// all of it goes; when it does not, the HEAD is preserved verbatim, the TAIL
// is filled newest-backwards, and the elision is marked - never silent.
//
// Pure, so the window arithmetic is testable without a database.

export interface HistoryRowLike {
  direction: string;
  body: string | null;
  raw?: unknown;
}

/** Placeholder bodies whose real content lives elsewhere on the row. */
const MEDIA_PLACEHOLDER = /^\[(voice note|video|audio)\]$/i;

export const HISTORY_CHAR_BUDGET = 4_000;
/** Oldest lines always kept - the RFQ + vehicle-naming turns. */
export const HISTORY_HEAD_LINES = 4;
export const HISTORY_ELISION = "(... earlier messages elided ...)";

/** One transcript line. Voice notes carry their transcript, not a placeholder. */
export function historyLine(m: HistoryRowLike): string {
  const who = m.direction === "outbound" ? "Us" : "Shop";
  const body = (m.body ?? "").trim();
  const raw = m.raw as
    | { transcript?: { text?: string }; reading?: { text?: string } }
    | null
    | undefined;
  const transcript = raw?.transcript?.text;
  // A photographed board read on turn N was INVISIBLE on turn N+1: history
  // inlined voice transcripts but never image readings, so the composer
  // negotiated against "[photo]" while the reading sat one JSONB field away.
  const reading = raw?.reading?.text;
  const text =
    MEDIA_PLACEHOLDER.test(body) && transcript
      ? `${body} ${transcript.trim()}`
      : MEDIA_PLACEHOLDER.test(body) && reading
        ? `${body} (photo read: ${reading.trim().slice(0, 200)})`
        : body;
  // AN EMPTY MESSAGE IS NOT A TURN. Returning "" lets the caller drop it on
  // CONTENT rather than on the length of the rendered line - the old
  // `length > 4` test measured the prefix too, so an empty outbound ("Us: ",
  // 4 chars) was dropped while an empty inbound ("Shop: ", 6 chars) survived
  // and fed the composer a shop turn that said nothing.
  if (!text.trim()) return "";
  return `${who}: ${text.slice(0, 300)}`;
}

/**
 * Build the history string from CHRONOLOGICAL rows (oldest first).
 *
 * Within budget: everything. Over budget: the head stays, the tail fills
 * newest-backwards, the gap is marked. The head is the part re-asking
 * destroys deals over; the tail is what the current turn answers.
 */
export function buildHistoryWindow(
  chronological: HistoryRowLike[],
  budgetChars = HISTORY_CHAR_BUDGET
): string {
  const lines = chronological.map(historyLine).filter(Boolean);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= budgetChars) return lines.join("\n");

  const head = lines.slice(0, HISTORY_HEAD_LINES);
  let used = head.reduce((n, l) => n + l.length + 1, 0) + HISTORY_ELISION.length + 1;
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= HISTORY_HEAD_LINES; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > budgetChars) break;
    tail.unshift(lines[i]);
    used += cost;
  }
  if (tail.length === lines.length - HISTORY_HEAD_LINES) return lines.join("\n");
  return [...head, HISTORY_ELISION, ...tail].join("\n");
}
