// A PAGE IS LOADING UNTIL ALL OF IT HAS LOADED.
//
// Trips showed its placeholder for under a second and then sat there, apparently
// finished and apparently empty, for ten more. Two things were wrong and they
// compound:
//
//   1. `loading` was owned by ONE fetch. The page starts two - the session and
//      the trips themselves - and whichever settled first cleared the flag. The
//      placeholder came down while half the page was still on its way, so the
//      traveller was shown a finished-looking page that had nothing in it.
//
//   2. The placeholder was invisible in dark mode (the shimmer highlight was
//      7% white), so even while it WAS showing, it read as a dead grey slab
//      rather than as work in progress.
//
// This fixes the first: readiness is the conjunction of every source a screen
// depends on, declared up front. A screen cannot accidentally become ready
// because one of its parts arrived - it has to say which parts there are.

import { useCallback, useMemo, useState } from "react";

export interface Readiness {
  /** True only once EVERY declared source has settled (resolved or failed). */
  ready: boolean;
  /** Mark one source settled. Safe to call more than once. */
  settle: (key: string) => void;
  /** Which sources are still outstanding - useful for a progress line. */
  pending: string[];
}

/**
 * Track a screen's data sources by name.
 *
 * Failure counts as settled: a source that errored is never coming, and holding
 * a placeholder up forever is a worse lie than showing an empty state. The
 * caller decides what to render; this only decides when the waiting is over.
 */
export function useReadiness(sources: readonly string[]): Readiness {
  const [settled, setSettled] = useState<Record<string, boolean>>({});

  const settle = useCallback((key: string) => {
    setSettled((s) => (s[key] ? s : { ...s, [key]: true }));
  }, []);

  const pending = useMemo(() => sources.filter((k) => !settled[k]), [sources, settled]);

  return { ready: pending.length === 0, settle, pending };
}

/**
 * The same rule as a pure function, so it can be reasoned about (and tested)
 * without a component.
 */
export function allSettled(sources: readonly string[], settled: Record<string, boolean>): boolean {
  return sources.every((k) => settled[k] === true);
}
