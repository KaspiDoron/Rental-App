// STRATEGIC WAIT BOUNDS.
//
// The live failure: the engine answered a shop instantly and correctly, and the
// app then told the traveller "Will is waiting on purpose ... (until 08:28 AM)"
// - eighteen hours out. Nothing clamped it. `waitMinutes` came straight from the
// model's JSON into `not_before`, so one hallucinated "wait until they open
// tomorrow" froze a live thread overnight.
//
// A deliberate pause is a real negotiation tactic - it stops us looking eager -
// but its whole value is measured in MINUTES. A shop that is typing right now
// forgets us in an hour. So the band is deliberately narrow and hard:
//
//   * anything the model asks for is pulled into [MIN, MAX]
//   * a non-number, NaN or a non-positive value means "no wait", not "wait 0"
//
// The graph engine has always clamped its director the same way
// (`clampNum(parsed.waitMinutes, 2, capMin, 5)` in graph/director.ts); SPTE is
// the primary engine now and was the one path missing the guard.

/** Shortest pause worth taking - below this it reads as an instant bot reply. */
export const WAIT_MIN_MINUTES = 1;
/** Hard ceiling. Owner directive: "a minute or two or even three, not hours." */
export const WAIT_MAX_MINUTES = 3;

/**
 * Pull a model-proposed wait into the safe band. Returns undefined when there is
 * no usable number, so callers can skip scheduling a wakeup entirely.
 */
export function clampWaitMinutes(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(WAIT_MAX_MINUTES, Math.max(WAIT_MIN_MINUTES, Math.round(raw)));
}
