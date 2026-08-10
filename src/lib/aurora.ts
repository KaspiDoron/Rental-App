// THE AURORA GLOW, AS ONE NAME - Wave D / M5 + M16.
//
// The class string lives here rather than being typed into each component,
// because "one shared primitive" is only true if there is one place that
// decides what the primitive is called. The moment a second component spells
// it out by hand, renaming or retiring the effect means hunting for string
// literals - which is how this app ended up with four spellings of a phone
// number and four counters for the same shop.
//
// The visual definition itself is CSS (`.aurora` in globals.css): an
// iridescent travelling rim, a soft bloom behind the surface, and a breath.
// CSS-only was a requirement, not a preference - a JS-driven glow on a loading
// screen competes for the main thread with the very work the user is waiting
// for.

/** The shared glow. Compose it onto any surface that is genuinely working. */
export const AURORA = "aurora";

/**
 * The glow, or nothing.
 *
 * Exists so a caller can write `aurora(isLoading)` instead of a ternary that
 * embeds the class name - which would defeat the point of the constant above.
 */
export function aurora(on = true): string {
  return on ? AURORA : "";
}
