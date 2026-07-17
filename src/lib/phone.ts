// The ONE phone-number normalizer. The digits-only regex was hand-copied at
// ~30 call sites - each a chance for a subtle drift (a missed `g` flag, a
// trim, a different empty-value fallback) in code where two "different"
// numbers mean a privacy boundary. Isomorphic + dependency-free.

/** Digits only: "+66 81-234 5678" -> "66812345678". Null-safe. */
export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** True when the string plausibly holds a full international number. */
export function looksLikePhone(s: string | null | undefined): boolean {
  const d = digitsOnly(s);
  return d.length >= 7 && d.length <= 15;
}
