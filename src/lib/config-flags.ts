// One dialect for every owner-facing on/off switch.
//
// The failure behind this file: the admin panel stored whatever string the
// owner typed, getPolicies() parsed DB boolean rows with `value === "true"`,
// and the FAST_DISPATCH config used the opposite polarity (on unless "off").
// A `fast_dispatch` row holding "on" therefore silently DISABLED fast
// dispatch and re-armed the business-hours park - the owner's own switch,
// inverted by a spelling. A flag written in any reasonable dialect must mean
// what the owner meant, and an unreadable spelling must keep the default -
// never silently flip to false.

const FLAG_ON = new Set(["on", "true", "1", "yes", "enabled"]);
const FLAG_OFF = new Set(["off", "false", "0", "no", "disabled"]);

/**
 * Parse an owner-written flag value. Accepts both dialects; anything else
 * (including empty/undefined) keeps the fallback.
 */
export function parseFlag(raw: unknown, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (FLAG_ON.has(v)) return true;
  if (FLAG_OFF.has(v)) return false;
  return fallback;
}

/** True when the value is a recognisable flag spelling in either dialect. */
export function isFlagValue(raw: unknown): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return FLAG_ON.has(v) || FLAG_OFF.has(v);
}

/** Canonical storage spelling - writes normalise to "true"/"false". */
export function normalizeFlag(raw: unknown, fallback: boolean): "true" | "false" {
  return parseFlag(raw, fallback) ? "true" : "false";
}
