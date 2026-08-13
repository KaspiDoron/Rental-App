// THE APPEND-ONLY RISK LEDGER - plan Part 9.7, Tier 3.
//
// WHY THIS EXISTS AT ALL, because a table is easy to add and easy to add
// wrongly: every safety signal in this system today is a MUTABLE SCALAR on one
// `whatsapp_number_reputation` row per user, overwritten on every send. After a
// restriction you can read what the counters are NOW and absolutely nothing
// about the preceding seventy-two hours. There is no numerator, there is no
// denominator, and there is therefore no rate to be 99% of.
//
// Three compounding defects made it worse than that sounds (Part 5.8):
//   - the cold-intro "ledger" is not data, it is re-derived on every read from
//     an unindexed JSON convention (`raw->>kind='rfq'`) that any of thirteen
//     outbound-writing call sites can silently break;
//   - the window query is capped in the WRONG DIRECTION - ascending with
//     limit 200 - so past 200 rows it keeps the oldest week-prefix and throws
//     away the most diagnostic recent ones;
//   - every telemetry read returns [] on failure, so "no activity" and "could
//     not read" are the same value.
//
// So: append-only, one row per event, never updated, never re-derived.
//
// TELEMETRY CAN NEVER BREAK A SEND. `noteRisk` swallows everything, awaits
// nothing the caller must wait on, and returns a boolean the caller is free to
// ignore. A ledger that can throw is a ledger that takes the product down the
// first time Supabase has a bad minute, and the whole point of it is to be
// running during the bad minutes.

import { sbInsert } from "../runtime-config";

/**
 * THE VOCABULARY. Twenty-three kinds, and the grouping is the argument.
 *
 * Part 0.37 established that there are TWO independent enforcement axes with
 * different penalties and different observability, and that treating them as
 * one number is the mistake that makes a risk dashboard misleading rather than
 * merely incomplete. Axis 1 is velocity - unanswered cold volume - and its
 * penalty is a scoped "you may reply, you may not start new chats". Axis 2 is
 * unofficial-client detection, its penalty is a full ban, and IT FIRES ON
 * ACCOUNTS DOING REPLY-ONLY WORK. A single blended score cannot represent
 * either, so the vocabulary keeps them apart from the first write.
 *
 * The third group is meter integrity, and it is not decoration. Part 9.2 found
 * four dashboard meters that are structurally dead, so the panel has to be able
 * to say "this reading is unverifiable" - which it can only do if the
 * ledger recorded whether the meters themselves were working.
 */
export const RISK_KINDS = [
  // ---- Axis 1: velocity, the metered quantity ----------------------------
  /** A cold introduction left for a shop with no prior inbound. */
  "intro_sent",
  /** That shop wrote back. On the documented mechanism this REFUNDS the slot. */
  "intro_answered",
  /** An introduction aged out of the window still unanswered. */
  "intro_unanswered_expired",
  /** The window's introduction budget refused a send. */
  "intro_budget_exhausted",
  /** An error-ack on a first-contact JID. Suspected, not confirmed. */
  "restriction_suspected",
  /** The lane differential confirmed it: cold fails, replies succeed. */
  "restriction_confirmed",
  /** Cold sends started succeeding again. */
  "restriction_cleared",

  // ---- Axis 2: client detection, the one pacing cannot touch --------------
  /** 401 - the link is gone. */
  "session_logged_out",
  /** 403 - forbidden. */
  "session_forbidden",
  /** 440 - another socket took the identity. Dual-socket, usually ours. */
  "session_replaced",
  /** 411 - multidevice mismatch. */
  "session_multidevice_mismatch",
  /** Socket open, keepalives fine, inbound stopped. The Baileys deaf case. */
  "session_deaf",
  /** What this session actually announced itself as, as a measured fact. */
  "fingerprint_observed",
  /**
   * The instance was destructively torn down and rebuilt (logout + delete +
   * recreate). Churn is itself an axis-2 signal: a number re-registering from
   * fresh sessions in quick succession is a known restriction vector, and
   * until this kind existed the rebuild storm was invisible in the ledger.
   */
  "instance_recreated",

  // ---- Meter integrity: can we believe anything above? -------------------
  "delivery_receipt",
  "read_receipt",
  /** Receipts were flowing and stopped. Distinct from an idle account. */
  "receipts_stalled",
  "send_failed",
  /**
   * The number is not on WhatsApp.
   *
   * ITS OWN KIND, DELIBERATELY. `recordSendFailure` counted this as a recipient
   * block, and blocks feed `Math.min(30, blocks_total * 12)` into a 100-point
   * score that auto-pauses at 70 - so three dead numbers in one batch could
   * pause a perfectly healthy account. A bad phone number in a Places listing
   * is a data-quality fact about the listing, not a judgement about the sender.
   */
  "recipient_invalid",
  /** A real recipient-side block, which WhatsApp does not actually report. */
  "recipient_blocked",

  // ---- Governor and policy ------------------------------------------------
  "ban_recovery_entered",
  /**
   * The pause lapsed.
   *
   * Recorded because `enterBanRecovery` restores the FULL plan budget the
   * moment `paused_until` passes - a restricted number goes straight back to
   * the behaviour that restricted it, and until now nothing anywhere noticed.
   */
  "ban_recovery_lapsed",
  /** A knob moved. Without this, no before/after on the dashboard means anything. */
  "policy_changed",
] as const;

export type RiskKind = (typeof RISK_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(RISK_KINDS);

/** Which axis a kind speaks to. `meter` speaks to whether the others are readable. */
export type RiskAxis = "velocity" | "client" | "meter" | "policy";

const AXIS: Record<RiskKind, RiskAxis> = {
  intro_sent: "velocity",
  intro_answered: "velocity",
  intro_unanswered_expired: "velocity",
  intro_budget_exhausted: "velocity",
  restriction_suspected: "velocity",
  restriction_confirmed: "velocity",
  restriction_cleared: "velocity",
  session_logged_out: "client",
  session_forbidden: "client",
  session_replaced: "client",
  session_multidevice_mismatch: "client",
  session_deaf: "client",
  fingerprint_observed: "client",
  instance_recreated: "client",
  delivery_receipt: "meter",
  read_receipt: "meter",
  receipts_stalled: "meter",
  send_failed: "meter",
  recipient_invalid: "meter",
  recipient_blocked: "meter",
  ban_recovery_entered: "policy",
  ban_recovery_lapsed: "policy",
  policy_changed: "policy",
};

export function axisOf(kind: RiskKind): RiskAxis {
  return AXIS[kind];
}

export function isRiskKind(k: string): k is RiskKind {
  return KIND_SET.has(k);
}

/**
 * Map a Baileys/Evolution disconnect code onto an axis-2 kind.
 *
 * Pure and exported so the mapping is testable, because the alternative is a
 * ternary chain buried in the webhook that nobody can check. Note what this
 * REPLACES: the old detector regex-matched `statusReason` against the words
 * "logged out" and "banned" while Evolution sends the number 401, so
 * `String(401).toLowerCase()` matched nothing and the branch never once fired.
 *
 * An unnamed code resolves to `session_forbidden` - the generic "WhatsApp
 * refused this session" - and the raw code always rides in `detail`, so a code
 * we have not seen before is recorded rather than dropped. That is deliberately
 * the opposite of the failure it replaces: an unrecognised reason must still
 * land in the ledger, just under a coarser label.
 */
export function sessionKindForCode(code: number | null | undefined): RiskKind {
  switch (code) {
    case 401:
      return "session_logged_out";
    case 411:
      return "session_multidevice_mismatch";
    case 440:
      return "session_replaced";
    case 403:
    default:
      return "session_forbidden";
  }
}

export interface RiskEventInput {
  senderKey: string;
  kind: RiskKind;
  /** Canonical shop key, when the event is about one recipient. */
  toKey?: string | null;
  /** Free-form, small, and NEVER a message body. */
  detail?: Record<string, unknown> | null;
  /**
   * What the fleet was configured as when this happened.
   *
   * Part 5.7's statistician: axis 2 is fleet-correlated common-mode risk, and
   * where one Meta rule keys on a shared config the effective sample size is 1.
   * Without this stamp, a config change and its consequences cannot be told
   * apart afterwards, which is the only comparison that would have mattered.
   */
  configFingerprint?: string | null;
  policyVersion?: string | null;
}

/**
 * How much of `detail` is allowed through.
 *
 * Bounded on purpose: this table is append-only and written from the send path,
 * so an unbounded blob is an unbounded row multiplied by every message the
 * fleet sends. Keys are capped and values are stringified and truncated - a
 * telemetry field is a label, not a payload.
 */
const MAX_DETAIL_KEYS = 12;
const MAX_DETAIL_VALUE = 200;

export function sanitizeDetail(
  detail: Record<string, unknown> | null | undefined
): Record<string, string> | null {
  if (!detail || typeof detail !== "object") return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(detail)) {
    if (n >= MAX_DETAIL_KEYS) break;
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (typeof s !== "string") continue;
    out[k.slice(0, 40)] = s.slice(0, MAX_DETAIL_VALUE);
    n++;
  }
  return n > 0 ? out : null;
}

/**
 * Write one risk event. NEVER THROWS, ever, for any input.
 *
 * Returns whether the row landed, which the rollup uses to mark a bucket's
 * `dark_signals[]` - so a period we could not record reads as unknown on the
 * dashboard rather than as a quiet zero. That is the entire difference between
 * this and the layer it replaces.
 */
export async function noteRisk(input: RiskEventInput): Promise<boolean> {
  try {
    const sender = String(input?.senderKey ?? "").trim().toLowerCase();
    // An event with no sender cannot be aggregated, attributed or acted on, and
    // writing it would put an unqueryable row in an append-only table forever.
    if (!sender) return false;
    if (!isRiskKind(String(input?.kind))) return false;
    const row = {
      sender_key: sender,
      kind: input.kind,
      axis: axisOf(input.kind),
      to_key: input.toKey ? String(input.toKey).slice(0, 40) : null,
      detail: sanitizeDetail(input.detail),
      config_fingerprint: input.configFingerprint ? String(input.configFingerprint).slice(0, 120) : null,
      policy_version: input.policyVersion ? String(input.policyVersion).slice(0, 60) : null,
      at: new Date().toISOString(),
    };
    return await sbInsert("wa_risk_events", [row]);
  } catch {
    // Deliberately total. See the header: the ledger exists to be running
    // during the bad minutes, so it must not be able to create one.
    return false;
  }
}
