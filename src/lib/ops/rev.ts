// Active behavior revision - the id of the most recently activated
// policy_versions row (either kind). Stamped onto every agent_traces and
// agent_scores row so quality analytics can split by "which behavior version
// produced this decision" and regressions after a change become measurable.
//
// Deliberately a tiny leaf module (only runtime-config imports) so both the
// hot path (orchestrator writeTrace, judge) and the policy layer can use it
// without import cycles.

import { getConfig } from "../runtime-config";

declare global {
  // eslint-disable-next-line no-var
  var __wd_ops_rev__: { at: number; value: number | null } | undefined;
}

/** The active policy_versions.id, or null before any versioned save. Cached 30s. */
export async function getActiveRev(): Promise<number | null> {
  const cached = globalThis.__wd_ops_rev__;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value: number | null = null;
  try {
    const raw = await getConfig("ops_active_rev");
    const n = Number(raw);
    if (raw && Number.isFinite(n) && n > 0) value = Math.round(n);
  } catch {
    /* stamps are best-effort */
  }
  globalThis.__wd_ops_rev__ = { at: Date.now(), value };
  return value;
}

/** Call after activating/rolling back a version so stamps update immediately. */
export function bustActiveRevCache(): void {
  globalThis.__wd_ops_rev__ = undefined;
}
