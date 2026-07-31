// The value contract for every anti-ban policy knob.
//
// whatsapp_security_policies rows are owner-typed strings. Before this file,
// the write side accepted anything and the read side coerced booleans with
// `value === "true"` and numbers with a bare Number() - so a typo'd row could
// silently invert a flag or set business hours to 700. The contract lives
// here, in one pure module, and BOTH sides use it: reads ignore values that
// violate it (the default survives), writes reject them loudly.

import { isFlagValue, normalizeFlag, parseFlag } from "../config-flags";

export type PolicySpec =
  | { kind: "flag" }
  | { kind: "number"; min: number; max: number };

/**
 * Must stay in sync with SecurityPolicies/DEFAULTS in wa-guard.ts - a
 * source-level test pins the key sets against each other.
 */
export const POLICY_SPEC: Record<string, PolicySpec> = {
  base_hour_cap: { kind: "number", min: 1, max: 500 },
  max_hour_cap: { kind: "number", min: 1, max: 1000 },
  day_cap: { kind: "number", min: 1, max: 5000 },
  min_gap_seconds: { kind: "number", min: 1, max: 3600 },
  gap_jitter_seconds: { kind: "number", min: 0, max: 3600 },
  // FLOOR = THE REAL SAFETY PROMISE, not a wish. The reply lane is gated by an
  // atomic fleet slot whose code floor is 5s (replyFleetGapSeconds in
  // wa-guard.ts), so a row saying 1 could never actually produce 1s spacing -
  // it only made the dial lie about what the engine would do. A knob must not
  // accept a number the engine will silently override.
  reply_gap_seconds: { kind: "number", min: 5, max: 600 },
  warmup_days: { kind: "number", min: 0, max: 60 },
  business_hour_start: { kind: "number", min: 0, max: 23 },
  business_hour_end: { kind: "number", min: 1, max: 24 },
  trust_reply_gain: { kind: "number", min: 0, max: 100 },
  trust_send_decay: { kind: "number", min: 0, max: 100 },
  engagement_halt: { kind: "flag" },
  presence_min_ms: { kind: "number", min: 0, max: 60_000 },
  presence_max_ms: { kind: "number", min: 0, max: 120_000 },
  idle_pause_hours: { kind: "number", min: 0, max: 168 },
  max_new_contacts_per_day: { kind: "number", min: 1, max: 10_000 },
  min_reply_rate: { kind: "number", min: 0, max: 1 },
  min_reply_samples: { kind: "number", min: 1, max: 1000 },
  risk_pause_threshold: { kind: "number", min: 1, max: 100 },
  risk_pause_minutes: { kind: "number", min: 1, max: 10_080 },
  burst_window_seconds: { kind: "number", min: 10, max: 86_400 },
  burst_max_in_window: { kind: "number", min: 1, max: 10_000 },
  burst_cooldown_minutes: { kind: "number", min: 0, max: 1440 },
  require_number_on_whatsapp: { kind: "flag" },
  daily_cap_jitter_pct: { kind: "number", min: 0, max: 90 },
  ignore_business_hours: { kind: "flag" },
  fast_dispatch: { kind: "flag" },
};

/** Read-side check: does this stored string carry a usable value? */
export function policyRowValue(
  key: string,
  raw: string,
  current: boolean | number
): boolean | number {
  const spec = POLICY_SPEC[key];
  if (!spec) return current;
  if (spec.kind === "flag") {
    // Tolerant read heals rows written before validation existed ("on",
    // "1", "yes" all count); an unreadable spelling keeps the effective
    // value instead of silently meaning false.
    return parseFlag(raw, Boolean(current));
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) return current;
  return n;
}

export type PolicyWriteVerdict =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

/**
 * Write-side gate: unknown keys and out-of-contract values are rejected with
 * a reason the admin panel can show; flags are normalised to "true"/"false".
 */
export function validatePolicyWrite(key: string, value: string): PolicyWriteVerdict {
  const spec = POLICY_SPEC[key];
  if (!spec) {
    return { ok: false, error: `Unknown policy "${key}" - check the spelling.` };
  }
  if (spec.kind === "flag") {
    if (!isFlagValue(value)) {
      return {
        ok: false,
        error: `"${value}" is not an on/off value - use true/on/1/yes or false/off/0/no.`,
      };
    }
    return { ok: true, normalized: normalizeFlag(value, false) };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `"${value}" is not a number.` };
  }
  if (n < spec.min || n > spec.max) {
    return { ok: false, error: `${key} must be between ${spec.min} and ${spec.max}.` };
  }
  return { ok: true, normalized: String(n) };
}
