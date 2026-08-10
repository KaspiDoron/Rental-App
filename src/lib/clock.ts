// Shared time formatting - `toLocaleTimeString([], { hour: "2-digit",
// minute: "2-digit" })` was hand-repeated across 11 sites / 8 files.
// Isomorphic + dependency-free.

/** "14:32" (locale-aware) from an ISO string, Date or epoch ms. */
export function formatClock(at: string | number | Date | null | undefined): string {
  if (at == null) return "";
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * "12 Aug" from a plain `YYYY-MM-DD` rental date.
 *
 * PARSED AS LOCAL, NOT UTC, and that is the whole reason this exists rather
 * than `new Date(s)`. `new Date("2026-08-12")` is specified to parse a
 * date-only string as UTC MIDNIGHT, so every traveller west of Greenwich sees
 * the day before the one they picked - a rental starting "11 Aug" on a form
 * where they chose the 12th. Splitting the parts and using the local-time
 * constructor keeps the label the same day the picker showed.
 *
 * Returns "" for anything unparseable, so a caller can `&&` it away rather than
 * render "Invalid Date".
 */
export function formatRentalDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd ?? "").trim());
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The rental window as one phrase: "12 Aug - 15 Aug", or just the start when
 * the end is unknown or identical.
 *
 * One function so the summary header, the wizard recap and any future surface
 * cannot disagree about how a window is written - the class of drift that gave
 * this app four different shop counters.
 */
export function formatDateRange(
  start: string | null | undefined,
  end?: string | null
): string {
  const a = formatRentalDate(start);
  if (!a) return "";
  const b = formatRentalDate(end);
  return b && b !== a ? `${a} - ${b}` : a;
}
