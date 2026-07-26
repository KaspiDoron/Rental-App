// Token-set (Jaccard) similarity for the anti-repetition backstop. The Redis
// copy-signature guard is a no-op on Cloud Run (no REDIS_URL), so nothing
// stopped the LLM sending near-identical bargains turn after turn. This is the
// keyless, per-thread fallback: compare a draft against our recent sends and
// block a near-duplicate so the engine re-composes with a different lever.

function tokens(s: string): Set<string> {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      // drop pure numbers so "320/day" vs "280/day" are NOT treated as different
      // (the SAME sentence with a swapped price IS the repetition we want to kill)
      .replace(/\b\d+\b/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/** Jaccard overlap of the two messages' word sets, 0..1. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** True when `draft` is a near-duplicate of any recent message (default 0.75). */
export function isRepetitive(draft: string, recent: string[], threshold = 0.75): boolean {
  return recent.some((m) => similarity(draft, m) >= threshold);
}
