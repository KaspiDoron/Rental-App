// The owner "aggressiveness" dial - a single live switch (the PACING_MODE config
// value, set in Admin -> Keys) that trades SPEED against ban-SAFETY with NO
// redeploy. It sets the pacing BASE that getPolicies layers under any explicit
// whatsapp_security_policies DB row (so per-key fine-tuning still wins on top).
//
// The dial governs the send RATE only - the full day-0 conversation budget (40
// ultra / 30 pro / 10 free) is unchanged by the mode; a user always gets their
// whole plan's worth of NEW conversations, the dial just decides how fast the
// messages leave and how early the guard eases off.
//
// Pure + isomorphic (no server-only import) so getPolicies and the tests share
// one definition. Keys map to fields of SecurityPolicies (all numeric).

export type PacingMode = "fast" | "balanced" | "cautious";

export const PACING_PRESETS: Record<PacingMode, Record<string, number>> = {
  // Maximum speed - a full ultra 40 clears in ~6-8 min. Highest ban exposure;
  // use when acquiring fast and the numbers are healthy.
  fast: {
    min_gap_seconds: 8,
    gap_jitter_seconds: 10,
    burst_max_in_window: 55,
    warmup_days: 3,
    risk_pause_threshold: 78,
  },
  // The tuned default balance - ~10-15 min for a full ultra batch.
  balanced: {},
  // Safety first - ~25-35 min for a full batch, tighter bursts, longer warm-up,
  // a lower daily ceiling and an earlier auto-pause. Use the moment a number
  // shows any strain (blocks, failed sends, a soft restriction).
  cautious: {
    min_gap_seconds: 30,
    gap_jitter_seconds: 45,
    burst_max_in_window: 10,
    burst_cooldown_minutes: 45,
    warmup_days: 14,
    day_cap: 120,
    risk_pause_threshold: 55,
  },
};

/** Map the raw config string (owner-typed) to a known mode; default balanced. */
export function normalizePacingMode(v?: string | null): PacingMode {
  const m = (v ?? "").trim().toLowerCase();
  if (m === "fast" || m === "aggressive" || m === "turbo") return "fast";
  if (m === "cautious" || m === "safe" || m === "slow" || m === "stealth") return "cautious";
  return "balanced";
}
