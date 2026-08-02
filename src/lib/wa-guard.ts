// Anti-Ban & AI Humanization Engine.
//
// WhatsApp's spam detection scores accounts on a few well-known vectors:
//   1. Velocity          - many first-contact messages in a short window
//   2. Content uniformity - identical/near-identical payloads (hash matching)
//   3. One-way blasts     - lots of outbound, few replies (no engagement)
//   4. Session anomalies  - sending at 3 AM recipient-time, instant sends with
//                           no "composing" presence, robotic fixed intervals
//   5. New-number bursts  - fresh numbers doing volume before earning trust
//
// This module addresses each vector with a database-driven policy layer:
//   - Dynamic reputation: `whatsapp_number_reputation` tracks a 0-100 Trust
//     Score per sender; the hourly cap SCALES with trust (replies earn trust,
//     pure outbound decays it). New numbers start on a warm-up budget.
//   - Engagement halt: no automated follow-up to a number until that number
//     has replied since our last outbound (two-way validation).
//   - Business hours: sends outside the recipient's local daytime window are
//     queued in `wa_outbox` and drained when the window opens.
//   - Content variance: every automated payload is passed through a semantic
//     variator so no two messages hash the same.
//   - All knobs live in `whatsapp_security_policies` - the owner tunes delays,
//     caps, scoring weights and hours from the DB without a redeploy.

import "server-only";
import { sbSelect, sbSelectStrict, sbInsert, sbUpdate, sbDelete, getConfig } from "./runtime-config";
import { parseFlag } from "./config-flags";
import { policyRowValue } from "./wa/policy-values";
import {
  resolveOffset,
  nextBusinessOpen,
  clampToBusinessHours,
  boundHold,
  recipientLocalHour,
} from "./wa/business-hours";
import { jitteredHold, HARD_MIN_GAP_SEC, RECIPIENT_LOCK_SEC } from "./wa/pacing";
import { digitsOnly } from "./phone";
import { numberFilter, waDigits, lidKey, outboxKey } from "./wa/phone-key";
import {
  claimOutboxRow,
  releaseOutboxRow,
  completeOutboxRow,
  MAX_DUP_HOLDS,
  type OutboxMeta,
  type OutboxRow,
} from "./wa/outbox-lifecycle";
import { personaHumanize } from "./wa/persona";
import { stealthFactor } from "./wa/stealth";
import { stripWaFormatting } from "./text";
import { PACING_PRESETS, normalizePacingMode } from "./wa/pacing-mode";
import {
  planCapacity,
  effectiveNewContactCap,
  effectiveHourCap,
  warmupFactor,
  nextIntroSlotIso,
} from "./wa/capacity";

// ---------------------------------------------------------------------------
// Policies - DB-driven control panel with safe defaults
// ---------------------------------------------------------------------------

export interface SecurityPolicies {
  base_hour_cap: number;        // messages/hour at trust 0
  max_hour_cap: number;         // messages/hour at trust 100
  day_cap: number;              // absolute per-day ceiling
  min_gap_seconds: number;      // min seconds between two sends (jittered up)
  gap_jitter_seconds: number;   // random extra gap 0..N
  reply_gap_seconds: number;    // per-engaged-shop min gap for REPLIES (tighter 3-7s lane)
  warmup_days: number;          // days a new number stays on half budget
  business_hour_start: number;  // recipient local hour (0-23)
  business_hour_end: number;    // recipient local hour (0-23)
  trust_reply_gain: number;     // trust points per inbound reply
  trust_send_decay: number;     // trust points lost per outbound with no reply
  engagement_halt: boolean;     // require a reply before the next auto message
  presence_min_ms: number;      // composing simulation floor
  presence_max_ms: number;      // composing simulation ceiling
  idle_pause_hours: number;     // hours without app activity before the user's
                                // WA session goes quiet (presence unavailable)
  // ---- Anti-Ban v2 knobs ----
  max_new_contacts_per_day: number; // cold first-contacts/day (biggest signal)
  min_reply_rate: number;           // below this (with enough samples) new
                                    // cold outreach is frozen
  min_reply_samples: number;        // sends needed before reply-rate matters
  risk_pause_threshold: number;     // ban-risk score (0-100) that auto-pauses
  risk_pause_minutes: number;       // how long an auto-pause lasts
  burst_window_seconds: number;     // rolling window for burst detection
  burst_max_in_window: number;      // max sends in that window before a rest
  burst_cooldown_minutes: number;   // enforced rest after a burst
  require_number_on_whatsapp: boolean; // validate the number exists on WA first
  daily_cap_jitter_pct: number;     // ± random daily-cap wobble (anti-pattern)
  ignore_business_hours: boolean;   // 24/7 dial: lift the recipient business-hours CLOCK gate for COLD intros (active replies already skip it). PACING_MODE=fast turns this on.
  fast_dispatch: boolean;           // owner directive: new users must dispatch their whole intro batch within ~10 min. Lifts BOTH the clock gate AND the Google "closed now" park for COLD intros, so a search fires immediately regardless of shop hours (the message waits unread until the shop opens). Config FAST_DISPATCH; DEFAULT ON.
}

const DEFAULTS: SecurityPolicies = {
  base_hour_cap: 4,
  max_hour_cap: 14,
  // Daily ceiling: a hard backstop against a runaway loop, NOT the per-session
  // limit. Cold introductions are separately bounded by the plan's newContacts
  // budget (40/window on ultra); the bulk of a busy day is REPLIES to shops that
  // messaged first (safe). 220 comfortably covers a full session of intros +
  // multi-round negotiation + a follow-up session, while still capping the
  // absolute worst case. The reply-rate breaker + risk pause are the real
  // behavioural guards.
  day_cap: 220,
  // Fast, human-jittered spacing: 12-28s between sends. A full ultra budget of
  // 40 conversations clears in ~10-15 min; free (10) in ~3 min; pro (30) in
  // ~8 min. Perfectly-regular intervals are a bot signature, so the jitter is
  // as important as the floor. This is the single strongest ban lever - raise
  // both numbers (DB override) if a number ever shows soft-restriction signs.
  min_gap_seconds: 12,
  gap_jitter_seconds: 16,
  // REPLY lane: replies to an ALREADY-ENGAGED shop (a two-way conversation the
  // shop started - low ban-risk) pace at ~5s per shop instead of the 12s cold
  // min-gap, so the back-and-forth feels responsive (the "3-7s response lane").
  // Cold first-contacts keep min_gap_seconds - velocity to NEW numbers is the
  // real ban vector, and the atomic fleet ceiling + stop-loss still apply.
  // Owner-tunable via a whatsapp_security_policies row `reply_gap_seconds`.
  reply_gap_seconds: 5,
  warmup_days: 7,
  // Wide default window (8-21): real rental shops open early and close late.
  // Google "open now" (shopOpenNow) is the primary truth when the client has
  // it; this clock window only gates sends when openNow is unknown.
  business_hour_start: 8,
  business_hour_end: 21,
  trust_reply_gain: 6,
  trust_send_decay: 1,
  engagement_halt: true,
  presence_min_ms: 2500,
  presence_max_ms: 8000,
  idle_pause_hours: 6,
  max_new_contacts_per_day: 15,
  min_reply_rate: 0.15,
  min_reply_samples: 8,
  risk_pause_threshold: 70,
  risk_pause_minutes: 240,
  // Burst guard aligned to the first-session blast: a new user firing their full
  // ultra budget of 40 in ~10 min must NOT trip a freeze after the 5th send (the
  // old 5/600s -> 30-min cooldown was the single hardest blocker of the owner's
  // "let them use their whole limit fast" goal). The min-gap already prevents
  // robotic rapid-fire; this only catches a pathological flood well above any
  // plan budget.
  burst_window_seconds: 600,
  burst_max_in_window: 45,
  burst_cooldown_minutes: 30,
  require_number_on_whatsapp: true,
  daily_cap_jitter_pct: 20,
  // Default OFF: cold intros still respect the recipient's business hours at
  // night. PACING_MODE=fast (or a DB override) flips this to send the whole
  // 40-intro burst NOW regardless of hour - the owner's explicit 24/7 dial.
  ignore_business_hours: false,
  // DEFAULT ON (owner directive: dispatch the whole intro batch within ~10 min).
  // Cold intros fire immediately, paced only by the min-gap - they are NOT
  // deferred to shop-open hours (the message simply waits unread until the shop
  // opens). Set FAST_DISPATCH=off to restore conservative business-hours
  // deferral for cold outreach.
  fast_dispatch: true,
};

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_policies__: { at: number; value: SecurityPolicies } | undefined;
}

export async function getPolicies(): Promise<SecurityPolicies> {
  const cached = globalThis.__wd_wa_policies__;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const [rows, modeRaw, fastRaw] = await Promise.all([
    sbSelect<{ key: string; value: string }>(
      "whatsapp_security_policies",
      // Ordered + generous limit: with the old bare limit=50, junk rows could
      // non-deterministically push a real override past the cut.
      "select=key,value&order=key.asc&limit=200"
    ),
    getConfig("PACING_MODE").catch(() => undefined),
    getConfig("FAST_DISPATCH").catch(() => undefined),
  ]);
  // Layer order: hard DEFAULTS -> owner speed/safety preset -> explicit DB rows.
  const mode = normalizePacingMode(modeRaw);
  // FAST_DISPATCH defaults ON (owner directive) - one shared flag dialect, an
  // unreadable spelling keeps the default instead of silently flipping.
  const fastDispatch = parseFlag(fastRaw, true);
  const merged: SecurityPolicies = {
    ...DEFAULTS,
    ...(PACING_PRESETS[mode] as Partial<SecurityPolicies>),
    // FAST is the owner's "send the whole burst NOW, any hour" dial - lift the
    // recipient business-hours clamp for cold intros (replies already skip it).
    // fast_dispatch (default ON) additionally lifts the Google "closed now" park
    // so a new user's whole batch fires within ~10 min regardless of shop hours.
    ignore_business_hours: mode === "fast" || fastDispatch,
    fast_dispatch: fastDispatch,
  };
  for (const r of rows) {
    const k = r.key as keyof SecurityPolicies;
    if (!(k in DEFAULTS)) continue;
    // The policy-values contract owns coercion: flags accept both dialects
    // (the old `=== "true"` turned a row spelled "on" into FALSE, silently
    // re-arming the business-hours park against the owner's own dial), and
    // numbers outside their sane range are ignored rather than applied.
    (merged as unknown as Record<string, unknown>)[k] = policyRowValue(
      r.key,
      r.value,
      (merged as unknown as Record<string, boolean | number>)[k]
    );
  }
  // Cross-field sanity: an inverted or degenerate hours window would turn
  // every hour of the day into "closed". Fall back to the shipped window.
  if (merged.business_hour_start >= merged.business_hour_end) {
    merged.business_hour_start = DEFAULTS.business_hour_start;
    merged.business_hour_end = DEFAULTS.business_hour_end;
  }
  globalThis.__wd_wa_policies__ = { at: Date.now(), value: merged };
  return merged;
}

/** Remove a policy override row so the code default applies again. */
export async function deletePolicy(key: string): Promise<void> {
  await sbDelete(
    "whatsapp_security_policies",
    `key=eq.${encodeURIComponent(key)}`
  );
  globalThis.__wd_wa_policies__ = undefined;
}

export async function setPolicy(key: string, value: string): Promise<void> {
  const rows = await sbSelect<{ id: number }>(
    "whatsapp_security_policies",
    `select=id&key=eq.${encodeURIComponent(key)}&limit=1`
  );
  if (rows[0]?.id) {
    await sbUpdate("whatsapp_security_policies", `id=eq.${rows[0].id}`, { value });
  } else {
    await sbInsert("whatsapp_security_policies", [{ key, value }]);
  }
  globalThis.__wd_wa_policies__ = undefined;
}

// ---------------------------------------------------------------------------
// Reputation - dynamic trust per sender (keyed by user email = one WA number)
// ---------------------------------------------------------------------------

export interface Reputation {
  id?: number;
  sender_key: string;
  trust_score: number;
  sent_total: number;
  replies_total: number;
  last_send_at: string | null;
  created_at?: string;
  blocks_total?: number;
  fails_total?: number;
  reads_total?: number;
  delivered_total?: number;
  new_contacts_today?: number;
  new_contacts_date?: string | null;
  last_reply_at?: string | null;
  paused_until?: string | null;
  risk_score?: number;
}

const REP_COLS =
  "id,sender_key,trust_score,sent_total,replies_total,last_send_at,created_at," +
  "blocks_total,fails_total,reads_total,delivered_total,new_contacts_today," +
  "new_contacts_date,last_reply_at,paused_until,risk_score";

/**
 * STRICT reputation read for the guard: null means the truth is UNKNOWN
 * (transient DB failure) - the caller must fail CLOSED for automated sends.
 * The permissive getReputation() below silently returns a FRESH default on
 * failure, which would read a paused/burned number as brand-new and healthy.
 */
async function getReputationStrict(senderKey: string): Promise<Reputation | null> {
  const res = await sbSelectStrict<Reputation>(
    "whatsapp_number_reputation",
    `select=${REP_COLS}&sender_key=eq.${encodeURIComponent(senderKey)}&limit=1`
  );
  if ("error" in res) {
    // Missing table = un-migrated/demo: today's permissive path is correct.
    return res.error === "missing" ? getReputation(senderKey) : null;
  }
  if (res.rows[0]) return res.rows[0];
  // Genuinely empty: a brand-new sender - create the warm-up row.
  return getReputation(senderKey);
}

async function getReputation(senderKey: string): Promise<Reputation> {
  const rows = await sbSelect<Reputation>(
    "whatsapp_number_reputation",
    `select=${REP_COLS}&sender_key=eq.${encodeURIComponent(senderKey)}&limit=1`
  );
  if (rows[0]) return rows[0];
  const fresh: Reputation = {
    sender_key: senderKey,
    trust_score: 20, // new numbers start low and EARN volume
    sent_total: 0,
    replies_total: 0,
    last_send_at: null,
  };
  await sbInsert("whatsapp_number_reputation", [
    { ...fresh, created_at: new Date().toISOString() },
  ]);
  return fresh;
}

/** Account age in days (0 for a brand-new number). */
function ageDaysOf(rep: Reputation): number {
  return rep.created_at ? (Date.now() - Date.parse(rep.created_at)) / 86_400_000 : 0;
}

/**
 * Warm-up ramp: a fresh number earns its full budget gradually over
 * `warmup_days`. Day 0 gets ~1/warmup of the budget, day warmup_days gets the
 * full budget. This is the single biggest protection for a NEW linked number.
 */
function warmupMultiplier(rep: Reputation, p: SecurityPolicies): number {
  // Humane ramp: a fresh number still warms up, but from a usable 45% floor
  // (not the old ~14% day-0 that made a new number nearly mute). The per-send
  // rate governors keep it safe at the floor. See wa/capacity.ts.
  return warmupFactor(ageDaysOf(rep), p.warmup_days);
}

/** Resolve a sender's plan (email = one WA number) for plan-tiered capacity. */
async function planForSender(senderKey: string): Promise<string> {
  try {
    const { getUser } = await import("./access");
    const u = await getUser(senderKey);
    return u?.plan ?? "free";
  } catch {
    return "free";
  }
}

/** Deterministic-per-day ±jitter so a fixed cap is not itself a pattern. */
function dailyCapJitter(senderKey: string, p: SecurityPolicies): number {
  const day = new Date().toISOString().slice(0, 10);
  let h = 0;
  const s = senderKey + day;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const frac = (h % 1000) / 1000; // 0..1 stable for the day
  const span = p.daily_cap_jitter_pct / 100;
  return 1 - span + frac * span * 2; // 1-span .. 1+span
}

/**
 * Hourly budget scales with trust, the warm-up ramp AND the plan (velocity
 * vector). A busy plan (Pro/Ultra) gets more headroom so replies + a paced
 * batch flow; a low-trust number still sits near the conservative base. The
 * 50-120s min-gap independently caps the true rate well below this.
 */
export function dynamicHourCap(rep: Reputation, p: SecurityPolicies, plan?: string): number {
  const t = Math.max(0, Math.min(100, rep.trust_score));
  const base = p.base_hour_cap + ((p.max_hour_cap - p.base_hour_cap) * t) / 100;
  return effectiveHourCap(plan ?? "free", base, ageDaysOf(rep), p.warmup_days);
}

/** New-shop introductions allowed per rolling window (plan x warm-up). */
function newContactCap(rep: Reputation, p: SecurityPolicies, plan?: string): number {
  return effectiveNewContactCap(plan ?? "free", ageDaysOf(rep), p.warmup_days);
}

/** Lifetime reply rate (0..1) - the strongest health signal. */
function replyRate(rep: Reputation): number {
  const sent = rep.sent_total || 0;
  if (sent === 0) return 1;
  return Math.min(1, (rep.replies_total || 0) / sent);
}

export interface RiskBreakdown {
  score: number; // 0..100
  reasons: string[];
}

/**
 * Ban-risk score from real behaviour. High score => the number looks like an
 * automated spammer to WhatsApp's heuristics and must be throttled/paused.
 */
export function computeRisk(rep: Reputation, p: SecurityPolicies): RiskBreakdown {
  const reasons: string[] = [];
  let risk = 0;

  // 1. Low reply rate is THE dominant spam signal.
  if ((rep.sent_total || 0) >= p.min_reply_samples) {
    const rr = replyRate(rep);
    if (rr < p.min_reply_rate) {
      const add = Math.round(((p.min_reply_rate - rr) / p.min_reply_rate) * 45);
      risk += add;
      reasons.push(`low reply rate ${(rr * 100).toFixed(0)}% (+${add})`);
    }
  }
  // 2. Blocks/reports from recipients are catastrophic.
  if ((rep.blocks_total || 0) > 0) {
    const add = Math.min(30, (rep.blocks_total || 0) * 12);
    risk += add;
    reasons.push(`${rep.blocks_total} block/report (+${add})`);
  }
  // 3. Failed sends (invalid/non-WA numbers) look like list-blasting.
  if ((rep.fails_total || 0) >= 3) {
    const add = Math.min(15, (rep.fails_total || 0) * 3);
    risk += add;
    reasons.push(`${rep.fails_total} failed sends (+${add})`);
  }
  // 4. Delivered but never read => nobody engages (bot pattern).
  if ((rep.delivered_total || 0) >= 8) {
    const readRate = (rep.reads_total || 0) / (rep.delivered_total || 1);
    if (readRate < 0.3) {
      risk += 12;
      reasons.push(`low read rate ${(readRate * 100).toFixed(0)}% (+12)`);
    }
  }
  // 5. A brand-new number doing anything is inherently riskier.
  if (ageDaysOf(rep) < 1 && (rep.sent_total || 0) > 3) {
    risk += 10;
    reasons.push("new number sending on day 1 (+10)");
  }

  return { score: Math.max(0, Math.min(100, risk)), reasons };
}

async function upsertRecipient(
  senderKey: string,
  toNumber: string,
  patch: Record<string, unknown>
): Promise<void> {
  const rows = await sbSelect<{ id: number }>(
    "wa_recipient_state",
    `select=id&sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(
      toNumber
    )}&limit=1`
  );
  if (rows[0]?.id) {
    await sbUpdate("wa_recipient_state", `id=eq.${rows[0].id}`, patch);
  } else {
    await sbInsert("wa_recipient_state", [
      { sender_key: senderKey, to_number: toNumber, ...patch },
    ]);
  }
}

/** Persist reputation and recompute the ban-risk score (auto-pause on spike). */
async function saveReputation(
  senderKey: string,
  patch: Partial<Reputation>
): Promise<void> {
  const rep = { ...(await getReputation(senderKey)), ...patch };
  const p = await getPolicies();
  const risk = computeRisk(rep, p);
  const update: Record<string, unknown> = { ...patch, risk_score: risk.score };
  // Auto-pause a number that has crossed the danger line. The pause blocks all
  // automated sending and the owner is alerted from the command center.
  if (risk.score >= p.risk_pause_threshold) {
    const until = new Date(Date.now() + p.risk_pause_minutes * 60_000).toISOString();
    const already = rep.paused_until && Date.parse(rep.paused_until) > Date.now();
    if (!already) {
      update.paused_until = until;
      try {
        await sbInsert("agent_events", [
          {
            kind: "wa-ban-risk",
            detail: `${senderKey} auto-paused ${p.risk_pause_minutes}min - risk ${risk.score}: ${risk.reasons.join("; ")}`,
          },
        ]);
      } catch {
        /* best-effort */
      }
    }
  }
  await sbUpdate(
    "whatsapp_number_reputation",
    `sender_key=eq.${encodeURIComponent(senderKey)}`,
    update
  );
}

/** Inbound reply: builds trust, records engagement, clears delivered-not-read. */
export async function recordInboundEngagement(
  senderKey: string,
  fromNumber?: string
): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    await saveReputation(senderKey, {
      trust_score: Math.min(100, rep.trust_score + p.trust_reply_gain),
      replies_total: (rep.replies_total || 0) + 1,
      last_reply_at: new Date().toISOString(),
    });
    if (fromNumber) {
      await upsertRecipient(senderKey, fromNumber, {
        last_reply_at: new Date().toISOString(),
        read: true,
        delivered: true,
      });
    }
  } catch {
    /* reputation is best-effort - never block the reply pipeline */
  }
}

/** Read receipt (blue tick) from Evolution messages.update - engagement proof. */
export async function recordReadReceipt(
  senderKey: string,
  toNumber: string
): Promise<void> {
  try {
    const rep = await getReputation(senderKey);
    await saveReputation(senderKey, {
      reads_total: (rep.reads_total || 0) + 1,
      delivered_total: Math.max((rep.delivered_total || 0), (rep.reads_total || 0) + 1),
    });
    await upsertRecipient(senderKey, toNumber, {
      read: true,
      delivered: true,
      last_read_at: new Date().toISOString(),
    });
  } catch {
    /* best-effort */
  }
}

/** Delivery ack (double grey tick) - message reached the device. */
export async function recordDelivery(
  senderKey: string,
  toNumber: string
): Promise<void> {
  try {
    const rep = await getReputation(senderKey);
    await saveReputation(senderKey, {
      delivered_total: (rep.delivered_total || 0) + 1,
    });
    await upsertRecipient(senderKey, toNumber, { delivered: true });
  } catch {
    /* best-effort */
  }
}

/** A send failed (invalid/non-WA number, or recipient blocked us). */
export async function recordSendFailure(
  senderKey: string,
  toNumber: string,
  kind: "fail" | "block" = "fail"
): Promise<void> {
  try {
    const rep = await getReputation(senderKey);
    if (kind === "block") {
      await saveReputation(senderKey, { blocks_total: (rep.blocks_total || 0) + 1 });
      await upsertRecipient(senderKey, toNumber, { blocked: true });
    } else {
      await saveReputation(senderKey, { fails_total: (rep.fails_total || 0) + 1 });
    }
  } catch {
    /* best-effort */
  }
}

async function recordOutboundSend(senderKey: string, toNumber?: string): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    const today = new Date().toISOString().slice(0, 10);
    const isNewDay = rep.new_contacts_date !== today;
    // Was this a brand-new cold contact (no prior recipient state)?
    let newContact = false;
    if (toNumber) {
      const prior = await sbSelect<{ id: number }>(
        "wa_recipient_state",
        `select=id&sender_key=eq.${encodeURIComponent(senderKey)}&to_number=eq.${encodeURIComponent(
          toNumber
        )}&limit=1`
      );
      newContact = prior.length === 0;
      await upsertRecipient(senderKey, toNumber, { last_sent_at: new Date().toISOString() });
    }
    await saveReputation(senderKey, {
      trust_score: Math.max(0, rep.trust_score - p.trust_send_decay),
      sent_total: (rep.sent_total || 0) + 1,
      last_send_at: new Date().toISOString(),
      new_contacts_date: today,
      new_contacts_today: (isNewDay ? 0 : rep.new_contacts_today || 0) + (newContact ? 1 : 0),
    });
  } catch {
    /* best-effort */
  }
}

/** Owner control: lift an auto-pause on a number. */
export async function clearPause(senderKey: string): Promise<void> {
  await sbUpdate(
    "whatsapp_number_reputation",
    `sender_key=eq.${encodeURIComponent(senderKey)}`,
    { paused_until: null, risk_score: 0 }
  );
}

// ---------------------------------------------------------------------------
// Recipient business hours - extracted to wa/business-hours (pure, exported,
// tested; the clamp is flag-aware there so no pacing hold can roll across the
// night while fast dispatch is on).
// ---------------------------------------------------------------------------

export { recipientLocalHour };

/**
 * Count the DISTINCT new-shop introductions (outbound RFQ opening messages)
 * this sender made inside the trailing rolling window, oldest-first. Migration
 * free: an RFQ IS a first-contact and whatsapp_messages.received_at is durable,
 * so no schema change is needed to make the budget rolling.
 */
export async function introductionsInWindow(
  senderKey: string,
  windowHours: number
): Promise<{ count: number; oldestAsc: string[]; entries: { toNumber: string; atMs: number }[] }> {
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const rows = await sbSelect<{ to_number: string; received_at: string }>(
    "whatsapp_messages",
    `select=to_number,received_at&direction=eq.outbound&raw->>kind=eq.rfq&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
      senderKey
    )}&received_at=gte.${encodeURIComponent(sinceIso)}&order=received_at.asc&limit=200`
  );
  const firstSeen = new Map<string, string>();
  for (const r of rows) if (!firstSeen.has(r.to_number)) firstSeen.set(r.to_number, r.received_at);
  const oldestAsc = [...firstSeen.values()].sort();
  // entries carry the distinct recipients so the Module-6 Redis mirror can seed
  // REAL members (member = to_number) and dedup future recordIntro calls.
  const entries = [...firstSeen.entries()].map(([toNumber, iso]) => ({
    toNumber,
    atMs: Date.parse(iso) || Date.now(),
  }));
  return { count: firstSeen.size, oldestAsc, entries };
}

export interface IntroBudget {
  remaining: number;
  cap: number;
  windowHours: number;
  /** ISO instant the next introduction slot frees (now, if already free). */
  nextFreeAt: string;
}

/**
 * How many NEW shops this sender can still introduce in the current ROLLING
 * window, and when the next slot frees. Plan-tiered and continuously
 * refreshing (free 10/6h, pro 15/4h, ultra 40/3h) - never a hard "everything
 * waits until tomorrow" wall. Exported so the mass-bargain route can tell the
 * user the truth AT CLICK TIME.
 */
export async function newContactBudget(senderKey: string, plan?: string): Promise<IntroBudget> {
  const p = await getPolicies();
  const rep = await getReputation(senderKey);
  const resolvedPlan = plan ?? (await planForSender(senderKey));
  const windowHours = planCapacity(resolvedPlan).windowHours;
  const cap = newContactCap(rep, p, resolvedPlan);
  let count = 0;
  let oldestAsc: string[] = [];
  try {
    const win = await introductionsInWindow(senderKey, windowHours);
    count = win.count;
    oldestAsc = win.oldestAsc;
  } catch {
    // Degrade to the legacy UTC-day counter if the window read fails.
    const today = new Date().toISOString().slice(0, 10);
    count = rep.new_contacts_date === today ? rep.new_contacts_today || 0 : 0;
  }
  const remaining = Math.max(0, cap - count);
  let nextFreeAt = nextIntroSlotIso(oldestAsc, windowHours, cap, Date.now());
  // Guard the fallback/edge case: budget spent but no window timestamps to
  // anchor to (the legacy-counter degrade path, or a count with no oldestAsc).
  // Without this, nextFreeAt is "now" while remaining is 0, so an over-budget
  // hold re-attempts every drain (a spin) instead of backing off a real gap.
  if (remaining <= 0 && Date.parse(nextFreeAt) <= Date.now() + 1000) {
    nextFreeAt = new Date(Date.now() + Math.min(windowHours, 1) * 3600_000).toISOString();
  }
  return { remaining, cap, windowHours, nextFreeAt };
}

/**
 * The CONSERVATIVE effective hourly send cap for this sender right now (trust +
 * warm-up adjusted), used by the batch stagger so it stamps not_before values
 * the drain will actually honor - no optimistic time that jumps an hour later.
 * We take 80% of the base (the drain applies a +/-20% daily jitter) and floor at
 * 1, so a staggered batch stays UNDER the drain's real cap in every window.
 */
export async function effectiveHourlyCap(senderKey: string, plan?: string): Promise<number> {
  const p = await getPolicies();
  const rep = await getReputation(senderKey);
  const resolvedPlan = plan ?? (await planForSender(senderKey));
  const base = dynamicHourCap(rep, p, resolvedPlan);
  const cap = Math.floor(base * 0.8);
  // Large caps (aged, high-trust numbers) lose ~1 to trust decay across a full
  // hour-group of sends, which would trip the drain's recomputed cap on the
  // tail item. Give them 1 extra slot of headroom. Small caps decay negligibly.
  const trimmed = Math.max(1, cap >= 6 ? cap - 1 : cap);
  // NEVER stamp the stagger below the plan's conversation budget: a within-budget
  // batch must fit inside ONE window, never split an hour out (the "18:24 then
  // jumped to 19:20" bug). The budget is the intended first-session burst; the
  // min-gap + reply-rate breaker are what actually keep the send rate safe.
  return Math.max(trimmed, planCapacity(resolvedPlan).newContacts);
}

/**
 * The instant the next introduction slot frees, clamped into the recipient's
 * business hours when the timezone is known. Exported for over-budget enqueues
 * - a rolling-window anchor at most windowHours away, never "tomorrow".
 */
export async function introHoldIso(
  senderKey: string,
  toDigits: string,
  region?: string,
  plan?: string
): Promise<string> {
  const p = await getPolicies();
  const { nextFreeAt } = await newContactBudget(senderKey, plan);
  return clampToBusinessHours(nextFreeAt, toDigits, p, region);
}

/**
 * Cold-outreach engagement over the trailing 7 days: how many DISTINCT shops
 * this sender introduced, and how many of them engaged (replied OR read).
 * Windowed on purpose - the lifetime replies_total/sent_total ratio latches
 * (see the breaker comment in guardOutbound). Null when unreadable: the
 * breaker then stands down - the risk pause and stop-loss still protect the
 * number, and a guard must not freeze outreach on its own blindness.
 */
const BREAKER_WINDOW_HOURS = 7 * 24;
export async function coldEngagementWindow(
  senderKey: string
): Promise<{ intros: number; engaged: number } | null> {
  try {
    const sinceIso = new Date(Date.now() - BREAKER_WINDOW_HOURS * 3600_000).toISOString();
    const { entries } = await introductionsInWindow(senderKey, BREAKER_WINDOW_HOURS);
    if (entries.length === 0) return { intros: 0, engaged: 0 };
    const introDigits = new Set(entries.map((e) => digitsOnly(e.toNumber)).filter(Boolean));
    const engaged = new Set<string>();
    const inbound = await sbSelect<{ from_number: string }>(
      "whatsapp_messages",
      `select=from_number&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        senderKey
      )}&received_at=gte.${encodeURIComponent(sinceIso)}&limit=300`
    );
    for (const r of inbound) {
      const d = digitsOnly(r.from_number ?? "");
      if (introDigits.has(d)) engaged.add(d);
    }
    // Read receipts count: a shop that READ us engaged with the number even
    // if it never typed - and reads are recorded through message-update
    // events, so they survive an inbound-text ingest defect.
    const state = await sbSelect<{ to_number: string; read: boolean | null; last_reply_at: string | null }>(
      "wa_recipient_state",
      `select=to_number,read,last_reply_at&sender_key=eq.${encodeURIComponent(senderKey)}&limit=500`
    );
    for (const r of state) {
      if (!r.read && !r.last_reply_at) continue;
      const d = digitsOnly(r.to_number ?? "");
      if (introDigits.has(d)) engaged.add(d);
    }
    return { intros: introDigits.size, engaged: engaged.size };
  } catch {
    return null;
  }
}

/**
 * A terminal refusal must leave a durable, attributable trace. Six shops once
 * rendered as "REMOVED BY YOU" precisely because their refusals (engagement
 * halt, dedup, tombstone) wrote nothing anywhere a client could read - the
 * poll's cancellation list became the only available "explanation".
 */
async function recordSendDropped(
  senderKey: string,
  toDigits: string,
  reason: string,
  meta?: Record<string, unknown>
): Promise<void> {
  const digits = digitsOnly(toDigits);
  await sbInsert("agent_events", [
    {
      kind: "send-dropped",
      vendor_id: typeof meta?.vendorId === "string" ? (meta.vendorId as string) : "",
      vendor_name: digits,
      ...(senderKey ? { user_email: senderKey } : {}),
      detail: JSON.stringify({ reason, digits }),
    },
  ]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Content variance - unique payload signature every time
// ---------------------------------------------------------------------------

const GREET_SWAPS: [RegExp, string[]][] = [
  // B2 fix: the old `^hi!?\s` only consumed "Hi " so it swapped INSIDE
  // "Hi there!" -> "Hey there! there!". Match the whole leading greeting phrase.
  [/^(?:hi|hey|hello)(?:\s+there)?!?[,\s]+/i, ["Hi! ", "Hey! ", "Hello! ", "Hi there! ", "Hey there! "]],
  [/\bthanks!?$/i, ["Thanks!", "Thank you!", "Thanks a lot!", "Thanks 🙏", "Ta!"]],
];

/**
 * Semantic variance for AUTOMATED messages: swap greetings/sign-offs, vary
 * contractions and spacing so the payload hash is unique per send while the
 * meaning stays identical. (LLM-composed messages are already unique - this
 * is the guarantee for deterministic/template fallbacks.)
 *
 * `rand` is injectable (B2/B4): guardOutbound seeds it from the message identity
 * so a parked row that is re-guarded produces the SAME text - the enqueue-time
 * humanization is never re-rolled, which is what kept two concurrent drainers'
 * idempotency hashes stable.
 */
export function humanizeVariant(text: string, rand: () => number = Math.random): string {
  let out = text;
  for (const [rx, pool] of GREET_SWAPS) {
    if (rx.test(out)) {
      const pick = pool[Math.floor(rand() * pool.length)];
      out = out.replace(rx, pick);
    }
  }
  // Contraction jitter (one direction only, keeps grammar safe).
  if (rand() < 0.5) out = out.replace(/\bI am\b/g, "I'm");
  if (rand() < 0.4) out = out.replace(/\bwhat is\b/gi, (m) => (m[0] === "W" ? "What's" : "what's"));
  if (rand() < 0.3) out = out.replace(/\bokay\b/gi, "ok");
  // Punctuation/spacing jitter - invisible to a human, new hash every time.
  if (rand() < 0.35) out = out.replace(/\. /g, ".  ");
  if (rand() < 0.3 && !/[?!]$/.test(out)) out = out.replace(/\.$/, "");
  // (Removed) the "typo *word" self-correction: it literally emitted a leading
  // asterisk into the sent message ("good *good day", "qiuck *quick question") -
  // it read as corrupted markdown, not a human touch. The contraction/spacing/
  // punctuation jitter above plus personaHumanize already guarantee a unique
  // payload hash per send, so nothing of value is lost.
  return out;
}

/**
 * Graduated ban-recovery: after a REAL WhatsApp restriction (a 401/logout or a
 * detected soft-ban), pause the number for a long rest, then it resumes under
 * the warm-up ramp. Called from the connection lifecycle handler.
 */
export async function enterBanRecovery(
  senderKey: string,
  hours = 24
): Promise<void> {
  try {
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    await sbUpdate(
      "whatsapp_number_reputation",
      `sender_key=eq.${encodeURIComponent(senderKey)}`,
      { paused_until: until, trust_score: 10 }
    );
    await sbInsert("agent_events", [
      {
        kind: "wa-ban-risk",
        detail: `${senderKey} entered ban-recovery: paused ${hours}h after a WhatsApp restriction/logout. Sending resumes slowly under warm-up.`,
      },
    ]);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Send-side STOP-LOSS (fast circuit breaker)
// ---------------------------------------------------------------------------
// computeRisk() is a SLOW, cumulative gauge (a failed send adds only ~+3, capped
// at +15), so a number that gets restricted mid-batch - the exact "your account
// is limited right now" state - would keep getting hammered shop after shop long
// before the cumulative risk crosses the pause threshold. This is the FAST trip:
// N consecutive HARD send failures inside a short window immediately enters
// ban-recovery, which sets paused_until, so guardOutbound then parks EVERY
// automated send for the whole account until the window clears. It is the honest,
// genuinely-protective core - not a promise of zero bans, but a guarantee the
// system stops digging the moment WhatsApp pushes back.
//
// SCOPE (be honest about it): the streak is in-memory per-process. That is the
// RIGHT scope for the long-lived workers process, where a failure burst happens
// inside one drain and the DURABLE effect it triggers (paused_until in
// whatsapp_number_reputation) is what every other instance then honors. On the
// SERVERLESS path it under-fires: the mass route parks all-but-slot-0 and the
// drain sends <=1 rfq/sender/invocation across ephemeral instances, so a single
// process rarely sees 3 hard failures in the window. The durable computeRisk
// gauge (recordSendFailure -> blocks_total/fails_total -> risk auto-pause) is the
// cross-instance safety net there; this breaker is the FAST trip that reliably
// protects the workers deployment. A "soft"/"ok" outcome resets the streak so
// isolated blips (one dead number in a good batch) never trip it.
const STOP_LOSS_MAX_FAILS = 3; // consecutive hard failures that trip the breaker
const STOP_LOSS_WINDOW_MS = 180_000; // ...within this window (older streak resets)
const STOP_LOSS_PAUSE_HOURS = 12; // automated queue halted this long once tripped

declare global {
  // eslint-disable-next-line no-var
  var __wd_send_streak__: Map<string, { n: number; first: number }> | undefined;
}
function sendStreak(): Map<string, { n: number; first: number }> {
  if (!globalThis.__wd_send_streak__) globalThis.__wd_send_streak__ = new Map();
  return globalThis.__wd_send_streak__;
}

/**
 * Record the outcome of one outbound send for the stop-loss breaker.
 *   "ok"   - delivered/accepted: clears the streak.
 *   "soft" - a failure that is NOT an account-restriction signal (e.g. one
 *            invalid/non-WhatsApp number): clears the streak (an isolated bad
 *            number in a healthy batch must not trip the breaker).
 *   "hard" - an account-level restriction signal (blocked/forbidden/401/403/429,
 *            or a socket drop / send timeout): increments the streak; on reaching
 *            STOP_LOSS_MAX_FAILS within the window it trips enterBanRecovery.
 * Returns { tripped } so callers can log/stop the current drain immediately.
 * Never throws - the send path must not break on the breaker.
 */
export async function noteSendOutcome(
  senderKey: string,
  outcome: "ok" | "soft" | "hard"
): Promise<{ tripped: boolean }> {
  try {
    if (outcome !== "hard") {
      sendStreak().delete(senderKey);
      return { tripped: false };
    }
    const now = Date.now();
    const rec = sendStreak().get(senderKey);
    if (!rec || now - rec.first > STOP_LOSS_WINDOW_MS) {
      sendStreak().set(senderKey, { n: 1, first: now });
      return { tripped: false };
    }
    rec.n += 1;
    if (rec.n >= STOP_LOSS_MAX_FAILS) {
      sendStreak().delete(senderKey);
      await enterBanRecovery(senderKey, STOP_LOSS_PAUSE_HOURS);
      try {
        await sbInsert("agent_events", [
          {
            kind: "wa-stop-loss",
            vendor_name: senderKey,
            detail:
              `STOP-LOSS: ${STOP_LOSS_MAX_FAILS} consecutive hard send failures in ` +
              `<${Math.round(STOP_LOSS_WINDOW_MS / 1000)}s - automated queue halted ` +
              `${STOP_LOSS_PAUSE_HOURS}h. The WhatsApp account is likely restricted; ` +
              `open the WhatsApp app to confirm and do NOT force sends during a restriction.`,
          },
        ]);
      } catch {
        /* logging is best-effort */
      }
      return { tripped: true };
    }
    return { tripped: false };
  } catch {
    return { tripped: false };
  }
}

// ---------------------------------------------------------------------------
// The gate - every automated outbound passes through here
// ---------------------------------------------------------------------------

export interface GuardVerdict {
  allow: boolean;
  reason?: string;
  queuedUntil?: string; // set when the message was parked in wa_outbox (re-queued)
  /**
   * WHICH ROW IT IS PARKED IN.
   *
   * Ops could tell the owner a message was "queued" and nothing else - the
   * chip is written once into the turn detail at compose time, agent_events
   * is append-only, and nothing ever joined back to wa_outbox. So a turn sent
   * at 12:43 still read `queued` an hour later, and "where is it held" had no
   * answer anywhere in the system. This is the exact join key.
   */
  outboxRowId?: number;
  terminal?: boolean;   // set when the message must be DROPPED for good (cancelled,
                        // duplicate, rfq-dedup, takeover). The drain uses this to
                        // tell "safely re-queued" and "deliberately dropped" apart
                        // from "rejected but NOT re-parked" - the last of which
                        // must never silently lose an already-claimed outbox row.
  text: string;         // the (possibly varied) payload to actually send
}

/**
 * Decide whether an outbound WhatsApp message may go out RIGHT NOW.
 * `auto` marks agent-generated messages (strictest rules); user-typed custom
 * messages skip the engagement halt but still respect volume caps.
 */
export async function guardOutbound(rawOpts: {
  senderKey: string; // user email (one connected WA number per user)
  toDigits: string;
  text: string;
  auto: boolean;
  queueIfBlocked?: boolean; // park in wa_outbox instead of rejecting
  region?: string;          // geocoded shop region - best timezone source
  shopOpenNow?: boolean;    // Google "open now" truth - overrides the clock
  meta?: Record<string, unknown>; // thread context for queued sends
  plan?: string;            // plan-tiered capacity (falls back to meta.plan)
  // B4: text pulled from wa_outbox was ALREADY humanized once at enqueue. The
  // drain must NOT re-run the unseeded persona/variance pass on it - doing so
  // mutates the text on every drainer, which changes its idempotency slot hash
  // and lets two concurrent drainers both send. When true, only the idempotent
  // stripWaFormatting runs; the stored text is delivered verbatim.
  alreadyHumanized?: boolean;
  /**
   * The wa_outbox row this send IS. Set by the drain, which now claims a row by
   * LEASE rather than deleting it, so the row still exists: a re-queue must
   * re-time THAT row, not insert a second pending message for the same shop.
   */
  outboxRowId?: number;
}): Promise<GuardVerdict> {
  // ONE canonical routing key for this whole call. Callers hand us whatever
  // spelling they hold - a JID with a device suffix, a "+63 966 …" from Google,
  // bare digits - and every row this function writes (the outbox row, the
  // recipient state, the sent message) becomes the anchor a later inbound reply
  // is matched against. Normalising HERE means one shop is one key everywhere
  // downstream, instead of three spellings that never meet.
  const opts = { ...rawOpts, toDigits: waDigits(rawOpts.toDigits) || rawOpts.toDigits };
  const region = opts.region ?? (typeof opts.meta?.region === "string" ? (opts.meta.region as string) : undefined);
  const plan = opts.plan ?? (typeof opts.meta?.plan === "string" ? (opts.meta.plan as string) : undefined);
  const p = await getPolicies();
  // AUTO messages get the full anti-fingerprinting pass: strip corporate
  // sign-offs, casualise toward a fast-typing traveller's register + a sparing
  // warm emoji (personaHumanize), THEN the hash-uniqueness variance
  // (humanizeVariant). stripWaFormatting is the LAST step, so no markdown/`*`
  // artifact from ANY upstream stage (composer or variance) can reach the shop.
  // A human's own typed message is only formatting-scrubbed, never reworded.
  // B4: an already-humanized (parked) row is delivered verbatim - only the
  // idempotent formatting scrub runs, so its slot hash stays STABLE across the
  // concurrent drainers and exactly one delivery happens.
  // B2/B4: the humanization is SEEDED from the message identity (sender + shop +
  // the composed text), so the SAME input always yields the SAME output. This
  // restores the copy engine's determinism contract and, together with
  // humanize-once, guarantees two drainers hash a parked row identically.
  const humanRand = (() => {
    let h = 2166136261 >>> 0;
    const seed = `${opts.senderKey}|${opts.toDigits}|${opts.text}`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return () => {
      // mulberry32 step - deterministic, well-distributed.
      h = (h + 0x6d2b79f5) >>> 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const text = opts.auto
    ? opts.alreadyHumanized
      ? stripWaFormatting(opts.text)
      : stripWaFormatting(humanizeVariant(personaHumanize(opts.text, humanRand), humanRand))
    : opts.text;
  const now = Date.now();
  // STRICT read: a null means the DB is unreachable RIGHT NOW. The guard must
  // never treat that as "fresh healthy number" - see the sync-retry hold
  // below the queue helper. Manual sends keep the permissive default (a human
  // pressing Send must not be blocked by our own outage).
  const repStrict = await getReputationStrict(opts.senderKey);
  const rep =
    repStrict ??
    ({ sender_key: opts.senderKey, trust_score: 20, sent_total: 0, replies_total: 0, last_send_at: null } as Reputation);

  // DISPATCH FACTS SURVIVE THE QUEUE. The mass route knows Google's "open
  // now" and the batch's 15-minute deadline at click time; the drain used to
  // re-guard parked rows blind to both, so a sibling of an immediate send
  // could be re-parked on facts dispatch had already refuted. Both now ride
  // the row's meta and are honored on every path.
  const shopOpenNow =
    typeof opts.shopOpenNow === "boolean"
      ? opts.shopOpenNow
      : typeof opts.meta?.openNow === "boolean"
        ? (opts.meta.openNow as boolean)
        : undefined;
  const batchDeadlineMs = Number(opts.meta?.batchDeadline);
  // A pacing-class hold on a fast-dispatch batch may defer INSIDE the batch
  // window, never past it - the 15-minute promise belongs to the batch, and
  // a per-message rule must not silently re-author it. Safety holds (pause,
  // ban recovery, fail-closed sync retries, breakers, burst rests, the
  // min-gap floor) are deliberately NOT routed through this.
  const boundToBatch = (iso: string): string => {
    if (!p.fast_dispatch) return iso;
    if (!Number.isFinite(batchDeadlineMs) || batchDeadlineMs <= now) return iso;
    const at = Date.parse(iso);
    if (!Number.isFinite(at) || at <= batchDeadlineMs) return iso;
    const floor = now + HARD_MIN_GAP_SEC * 1000;
    return new Date(Math.max(Math.min(at, batchDeadlineMs), floor)).toISOString();
  };

  const queue = async (notBefore: string, reason: string): Promise<GuardVerdict> => {
    if (opts.queueIfBlocked !== false) {
      // ALREADY A ROW: this send came off the queue and is only being re-timed.
      // Patching it keeps one row per message, so the shop stays continuously
      // visible and no insert can fail in a way that loses the message.
      if (opts.outboxRowId) {
        const { releaseOutboxRow } = await import("./wa/outbox-lifecycle");
        const held = await releaseOutboxRow(opts.outboxRowId, notBefore, {
          ...(opts.meta ?? {}),
          reason,
        });
        return held
          ? { allow: false, reason: `${reason} - queued`, queuedUntil: notBefore, text, outboxRowId: opts.outboxRowId }
          : { allow: false, reason, text };
      }
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: opts.senderKey,
          to_number: opts.toDigits,
          to_key: outboxKey(opts.toDigits),
          body: text,
          not_before: notBefore,
          // Keep the human reason with the row so the queue viewer explains why.
          meta: { ...(opts.meta ?? {}), reason },
        },
      ]);
      // B4: the partial unique index (sender_key,to_number) rejects a SECOND
      // pending automated row for the same shop. A failed insert is therefore
      // ambiguous: DB outage, OR a pending row for this shop already exists (a
      // genuine duplicate we WANT to suppress). Disambiguate: if a pending
      // automated row is already there, this send is effectively queued - report
      // success against that row instead of creating a duplicate.
      if (!parked) {
        const kind = typeof opts.meta?.kind === "string" ? (opts.meta.kind as string) : "";
        if (kind !== "custom" && kind !== "human-manual") {
          const existing = await sbSelect<{ not_before: string }>(
            "wa_outbox",
            `select=not_before&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
              `&to_number=eq.${encodeURIComponent(opts.toDigits)}` +
              `&order=not_before.asc&limit=1`
          ).catch(() => []);
          if (existing[0]) {
            return { allow: false, reason: `${reason} - already queued`, queuedUntil: existing[0].not_before, text };
          }
        }
      }
      // Only claim queuedUntil when the row ACTUALLY persisted. If the insert
      // failed (DB blip / the 8s fetch timeout), returning queuedUntil would
      // make the drain's needsRepark believe the row is safely parked and DROP
      // the claimed (already-deleted) row - silent data loss. Omitting it makes
      // needsRepark re-park via the drain's own belt (a second insert attempt);
      // the idempotency preflight + msg claim slot prevent a double-send if the
      // first insert actually landed but its response timed out.
      if (parked) {
        // Read the id back so Ops can point at the exact row. One extra query,
        // only on the path that is already parking a message, and a failure to
        // find it costs a join and nothing else - never the send.
        const mine = await sbSelect<{ id: number }>(
          "wa_outbox",
          `select=id&sender_key=eq.${encodeURIComponent(opts.senderKey)}` +
            `&to_number=eq.${encodeURIComponent(opts.toDigits)}&order=id.desc&limit=1`
        ).catch(() => [] as { id: number }[]);
        return {
          allow: false,
          reason: `${reason} - queued`,
          queuedUntil: notBefore,
          text,
          outboxRowId: mine[0]?.id,
        };
      }
      return { allow: false, reason, text };
    }
    return { allow: false, reason, text };
  };

  // -3. FAIL CLOSED ON UNKNOWN SAFETY STATE. If the reputation row (pause
  //     state, trust, caps history) is unreadable, an automated send holds
  //     briefly instead of assuming "brand-new healthy number" - a Supabase
  //     blip must never disable the anti-ban engine.
  if (opts.auto && repStrict === null) {
    return await queue(jitteredHold(now, 5, 5), "sync-retry");
  }

  // -2. CANCELLATION TOMBSTONE + HUMAN TAKEOVER - the two absolute vetoes.
  //     Every automated path (outbox drain, wakeup re-composition, retries)
  //     converges here, so enforcing the user's "remove"/"I've got this chat"
  //     at this choke point is what makes them PERMANENT. Distinctions:
  //       cancelled === true  -> refuse outright (never queued, never retried;
  //                              the drain drops non-queued rejections)
  //       cancelled === null  -> the tombstone table is unreadable RIGHT NOW:
  //                              the truth is unknown, so fail CLOSED - hold
  //                              briefly and let a later drain re-check. A
  //                              missing (un-migrated) table reads as false.
  if (opts.auto) {
    const { isCancelled, recordSuppressedSend } = await import("./wa/cancellations");
    const cancelled = await isCancelled(opts.senderKey, opts.toDigits);
    if (cancelled === true) {
      void recordSuppressedSend(opts.senderKey, opts.toDigits, "cancelled-send-blocked");
      return {
        allow: false,
        terminal: true,
        reason: "cancelled-by-user - you removed the messages to this shop",
        text,
      };
    }
    if (cancelled === null) {
      return await queue(
        new Date(now + (5 + Math.random() * 5) * 60_000).toISOString(),
        "sync-retry"
      );
    }
    {
      const { isThreadTakenOver } = await import("./session-flags");
      let takeover: boolean | null;
      try {
        takeover = await isThreadTakenOver(opts.senderKey, opts.toDigits);
      } catch {
        takeover = null; // unreadable -> fail closed below
      }
      if (takeover === true) {
        void recordSuppressedSend(opts.senderKey, opts.toDigits, "takeover-send-blocked");
        return {
          allow: false,
          terminal: true,
          reason: "human takeover - you are chatting with this shop yourself",
          text,
        };
      }
      if (takeover === null) {
        // UNKNOWN takeover state (store unreadable): takeover is an absolute
        // veto, so an automated send fails CLOSED - hold and re-check later
        // rather than risk posting into a thread the human took over. Mirrors
        // the cancellation null-path above. (This block runs only for auto.)
        return await queue(jitteredHold(now, 5, 5), "sync-retry");
      }
    }
  }

  // -1. IDEMPOTENCY / DEDUP PRE-FLIGHT. Never send the EXACT same text to the
  //     same shop twice in a short window - this is the hard stop against a
  //     message loop (the "agent sent the same message again" bug). Compares
  //     the normalized body against this sender's recent outbound to this
  //     number.
  {
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    const recentOut = await sbSelect<{ body: string | null }>(
      "whatsapp_messages",
      `select=body&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&received_at=gte.${encodeURIComponent(
        new Date(now - 6 * 3600_000).toISOString()
      )}&order=received_at.desc&limit=8${numberFilter("to_number", opts.toDigits)}`
    );
    const isDup = recentOut.some(
      (m) => (m.body ?? "").replace(/\s+/g, " ").trim().toLowerCase() === normalized
    );
    if (isDup) {
      void recordSendDropped(opts.senderKey, opts.toDigits, "duplicate message suppressed (idempotency)", opts.meta);
      return { allow: false, terminal: true, reason: "duplicate message suppressed (idempotency)", text };
    }
  }

  // -0.5. ONE RFQ PER SHOP PER DAY. A fresh opening question into a thread
  //       where we ALREADY asked recently ("do you have a 125cc scooter...?"
  //       twice in one morning) screams bot - the text differs, the question
  //       is the same. Auto RFQs to a number that already received an RFQ from
  //       this sender in the last 24h are dropped (never queued); the existing
  //       conversation is the place to continue.
  if (opts.auto && opts.meta?.kind === "rfq") {
    const priorRfq = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&raw->>kind=eq.rfq&received_at=gte.${encodeURIComponent(
        new Date(now - 24 * 3600_000).toISOString()
      )}&limit=1${numberFilter("to_number", opts.toDigits)}`
    );
    if (priorRfq.length > 0) {
      void recordSendDropped(opts.senderKey, opts.toDigits, "rfq-dedup - this shop was already asked in the last 24h", opts.meta);
      return {
        allow: false,
        terminal: true,
        reason: "rfq-dedup - this shop was already asked in the last 24h",
        text,
      };
    }
  }

  // Is this a brand-new cold contact (no prior message to this number)?
  const priorRecipient = await sbSelect<{ id: number }>(
    "wa_recipient_state",
    `select=id&sender_key=eq.${encodeURIComponent(opts.senderKey)}&to_number=eq.${encodeURIComponent(
      opts.toDigits
    )}&limit=1`
  );
  const isNewContact = priorRecipient.length === 0;

  // 0.0 THE OWNER'S KILL SWITCH, ENFORCED WHERE SENDS ACTUALLY HAPPEN.
  //
  //     KILL_SWITCH was checked in six API routes - vendors, geocode, outreach,
  //     mass outreach, recheck, checkout - and in NONE of the paths that
  //     actually put a message on WhatsApp. So flipping it stopped new searches
  //     while every already-queued introduction and every agent reply kept
  //     going out: the one control the owner has for "stop, something is
  //     wrong" did not stop the thing most worth stopping.
  //
  //     Automated sends PARK rather than fail, so nothing is lost - the queue
  //     drains by itself once the switch goes back off. A human's own typed
  //     message is deliberately still allowed: the switch halts the agents, and
  //     a person deciding to message a shop themselves is not the agents.
  //
  //     killSwitchOn() now fails CLOSED on an unreadable vault (see usage.ts),
  //     which is why this parks with a short re-check rather than a long hold.
  if (opts.auto) {
    const { killSwitchOn } = await import("./usage");
    if (await killSwitchOn()) {
      return await queue(jitteredHold(now, 6, 4), "paused by the operator (kill switch)");
    }
  }

  // 0. GLOBAL ACCOUNT PAUSE - a number the risk engine (or a real WhatsApp
  //    restriction) has quarantined sends nothing until the pause expires.
  //    This is the graduated ban-recovery guard from the research.
  if (rep.paused_until && Date.parse(rep.paused_until) > now) {
    if (opts.auto) return await queue(rep.paused_until, "number paused (ban-risk recovery)");
    return { allow: false, reason: "This number is paused for safety recovery.", text };
  }

  // 0.1 USER SESSION PAUSE - "Will, hold everything". Automated sends queue
  //     for an hour with an honest reason; the user's own explicit sends
  //     (custom messages) still go through - the pause binds the AGENTS.
  if (opts.auto) {
    const { isSessionPaused } = await import("./session-flags");
    let paused: boolean | null;
    try {
      paused = await isSessionPaused(opts.senderKey);
    } catch {
      paused = null; // unreadable -> fail closed below
    }
    if (paused === true) {
      // SHORT hold, jittered so a batch paused together does not RELEASE
      // together. It used to be 60-75 min, which made the pause the single
      // slowest thing in the app: a traveller who resumed still watched
      // "sends in ~64 min" because the parked rows kept their hour. Resume now
      // releases them outright (wa/resume-queue), and this hold is only the
      // backstop for a resume that happened somewhere this instance cannot see
      // - so it re-checks in minutes, not in an hour. A still-paused row simply
      // re-parks; nothing is sent while the hold is on.
      return await queue(jitteredHold(now, 6, 4), "paused by you");
    }
    if (paused === null) {
      // UNKNOWN pause state (store unreadable): "hold everything" is absolute,
      // so an automated send fails CLOSED - brief sync-retry hold, not a send.
      return await queue(jitteredHold(now, 5, 5), "sync-retry");
    }
  }

  // 1. TWO-WAY ENGAGEMENT HALT. Never send a second AUTOMATED message to a
  //    number until it has engaged - a reply OR at least a read receipt (blue
  //    tick). Delivered-but-ignored contacts are the #1 spam signal, so we do
  //    NOT keep pushing them.
  //    A fresh RFQ is EXEMPT: an RFQ only ever originates from an explicit
  //    user action (a search batch or an "Ask for price" tap), and the same
  //    doctrine that lets a user action clear a cancellation tombstone
  //    applies - the user re-initiating IS the signal. The 24h rfq-dedup
  //    above still blocks a repeat ask; this halt is for the AGENT's own
  //    follow-ups. (Before this exemption, re-selecting a shop from an
  //    earlier silent batch was terminally dropped with no trace - the shop
  //    then surfaced as "removed by you".)
  const freshUserRfq = opts.meta?.kind === "rfq";
  if (opts.auto && p.engagement_halt && !isNewContact && !freshUserRfq) {
    // Scoped to THIS sender: another user's thread with the same shop must
    // never trip (or clear) this user's engagement halt.
    const lastOut = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        opts.senderKey
      )}&order=received_at.desc&limit=1${numberFilter("to_number", opts.toDigits)}`
    );
    if (lastOut[0]) {
      const inboundSince = await sbSelect<{ id: number }>(
        "whatsapp_messages",
        // PRIVACY + correctness: only replies THIS user's WhatsApp received
        // count as engagement (another user's thread with the same shop must
        // never clear this user's halt). Legacy unstamped rows fall back to
        // the durable wa_recipient_state check below.
        // Number matching is TOLERANT here or the halt reads a real reply as
        // silence: the shop's inbound row carries WhatsApp's spelling while
        // `toDigits` carries discovery's, and an exact match between them made
        // an engaged shop look ignored - which TERMINALLY dropped our answer.
        `select=id&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
          opts.senderKey
        )}&received_at=gte.${encodeURIComponent(
          lastOut[0].received_at
        )}&limit=1${numberFilter("from_number", opts.toDigits)}`
      );
      const state = await sbSelect<{ read: boolean; last_reply_at: string | null }>(
        "wa_recipient_state",
        `select=read,last_reply_at&sender_key=eq.${encodeURIComponent(
          opts.senderKey
        )}&to_number=eq.${encodeURIComponent(opts.toDigits)}&limit=1`
      );
      const engaged =
        inboundSince.length > 0 || state[0]?.read || Boolean(state[0]?.last_reply_at);
      if (!engaged) {
        // TERMINAL drop, not a re-park. A 2nd automated message to a shop that
        // has not replied/read is the #1 spam signal, so we do not send it - and
        // we must not leave it perpetually re-parking in the queue either (that
        // is what kept a duplicate follow-up visible forever and burned drain
        // cycles). If the shop later engages, a fresh turn composes a new
        // message that passes this halt. The drop leaves a durable trace -
        // this branch used to write NOTHING, making it indistinguishable from
        // a user removal after the fact.
        void recordSendDropped(opts.senderKey, opts.toDigits, "engagement-halt: no reply or read receipt yet", opts.meta);
        return {
          allow: false,
          terminal: true,
          reason: "engagement-halt: no reply or read receipt yet",
          text,
        };
      }
    }
  }

  // 2. RECIPIENT BUSINESS HOURS - never message a shop at 3 AM local time.
  //    Priority of truth:
  //      a) Google "open now" (opts.shopOpenNow) - the SAME signal the card
  //         shows the user, so the app never says "open" then queues as "closed".
  //      b) The recipient's local clock, timezone resolved from the region
  //         string first, then the phone prefix.
  //      c) If the timezone is genuinely unknown, DO NOT queue - a false
  //         "closed" on an open shop is the worse bug (issue #21).
  if (opts.auto && shopOpenNow !== true) {
    // ACTIVE-CONVERSATION OVERRIDE: if this shop wrote to THIS user within the
    // last 30 minutes, they are demonstrably at the phone RIGHT NOW - queuing
    // a reply "until the shop opens" would be absurd (and was: a deal-close on
    // a live chat once queued for "opening hours" on a wrong-timezone number).
    const recentInbound = await sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.inbound&from_number=eq.${encodeURIComponent(
        opts.toDigits
      )}&raw->>receiver=eq.${encodeURIComponent(
        opts.senderKey
      )}&received_at=gte.${encodeURIComponent(
        new Date(now - 30 * 60_000).toISOString()
      )}&limit=1`
    ).catch(() => []);
    const activelyChatting = recentInbound.length > 0;
    const { off, known } = resolveOffset(opts.toDigits, region);
    // FAST DISPATCH (owner directive): a new user's whole batch must go out
    // within ~10 min, so cold intros are NOT deferred to shop-open - even when
    // Google reports the shop closed right now. The message simply waits unread
    // until they open. This lifts the Google-closed park below (the clock gate
    // is lifted separately via ignore_business_hours).
    if (!activelyChatting && shopOpenNow === false && !p.fast_dispatch) {
      // Google says closed. If it is DAYTIME at the shop (lunch break, late
      // opening), retry within the hour instead of parking until tomorrow
      // morning - the old behavior turned a 13:00 opening into a 22h wait.
      const localH = (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
      const daytime = known && localH >= p.business_hour_start && localH < p.business_hour_end;
      const until = daytime
        ? new Date(Date.now() + (45 + Math.random() * 30) * 60_000).toISOString()
        : nextBusinessOpen(opts.toDigits, p, region);
      return await queue(until, "shop is closed now");
    }
    // The CLOCK-window gate (not the Google "closed now" gate above) is what the
    // 24/7 dial lifts: ignore_business_hours (PACING_MODE=fast) skips ONLY this,
    // so a fast-mode burst goes out at any hour, while a shop Google reports
    // DEFINITELY closed right now still parks above - a definitively-closed shop
    // won't reply, and blasting it hurts reply-rate (a real ban signal).
    if (known && !activelyChatting && !p.ignore_business_hours) {
      const localHour =
        (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
      const inWindow = localHour >= p.business_hour_start && localHour < p.business_hour_end;
      if (!inWindow) {
        return await queue(
          boundToBatch(nextBusinessOpen(opts.toDigits, p, region)),
          "outside recipient business hours"
        );
      }
    }
    // unknown timezone => allow (never false-queue an open shop)
  }

  // 3. COLD-OUTREACH GOVERNOR (only for brand-new first contacts - the highest
  //    ban-risk action). Combines: daily new-contact cap, reply-rate circuit
  //    breaker, and delivery-rate circuit breaker (double-tick < threshold).
  if (opts.auto && isNewContact) {
    // ROLLING-WINDOW introductions budget (plan-tiered, continuously
    // refreshing: free 10/6h, pro 15/4h, ultra 40/3h). When it is spent, hold
    // to when the next slot frees - at most windowHours away, clamped into the
    // shop's business hours - NEVER a hard "tomorrow morning" wall. Capacity
    // comes back gradually as the oldest introduction ages out of the window.
    const budget = await newContactBudget(opts.senderKey, plan).catch(() => null);
    const windowHours = Math.max(1, planCapacity(plan).windowHours);
    if (budget && budget.remaining <= 0) {
      // Bounded by the plan's own window - a budget wait is a pace, never a
      // wall (and the clamp stands down entirely under fast dispatch).
      const until = boundHold(
        clampToBusinessHours(budget.nextFreeAt, opts.toDigits, p, region),
        now,
        windowHours
      );
      return await queue(until, "introductions full - refreshes soon");
    }
    // Reply-rate breaker: if enough recent history exists and almost nobody
    // engages, freeze cold outreach - that pattern is what actually trips
    // WhatsApp's filters. HOLD (queue), never DROP: on the drain path the row
    // was already claimed, so a bare !allow would silently LOSE the message.
    //
    // WINDOWED, ENGAGEMENT-BASED - deliberately not the lifetime ratio it
    // used to be. replies_total/sent_total latches: the denominator grows
    // with every send while the numerator depends on inbound ingest actually
    // recording replies, so one ingest defect froze every future batch
    // permanently - and the unconditional business-hours clamp then rolled
    // the 2-4h hold to the NEXT MORNING (the 05:38 incident). The window
    // measures the last 7 days, a READ receipt counts as engagement (reads
    // are recorded even when a reply's text is dropped), the freeze
    // self-expires inside the plan window, and it never crosses the night
    // under fast dispatch.
    const win = await coldEngagementWindow(opts.senderKey);
    if (win && win.intros >= p.min_reply_samples) {
      const rate = win.engaged / Math.max(1, win.intros);
      if (rate < p.min_reply_rate) {
        const until = boundHold(
          clampToBusinessHours(
            new Date(now + (2 + Math.random() * 2) * 3600_000).toISOString(),
            opts.toDigits,
            p,
            region
          ),
          now,
          windowHours
        );
        return await queue(
          until,
          `reply-rate circuit breaker (${(rate * 100).toFixed(0)}% < ${(p.min_reply_rate * 100).toFixed(0)}%) - cold outreach frozen to protect the number`
        );
      }
    }
    // Delivery-rate breaker (research: double-tick threshold ~60%). Delivery
    // receipts flow through message-update events, not text ingest, so the
    // lifetime counters stay live here - but the hold is bounded and no
    // longer rolls across the night.
    if ((rep.delivered_total || 0) >= 8) {
      const delivRate = (rep.delivered_total || 0) / Math.max(1, rep.sent_total || 0);
      if (delivRate < 0.6) {
        const until = boundHold(
          clampToBusinessHours(
            new Date(now + (2 + Math.random() * 2) * 3600_000).toISOString(),
            opts.toDigits,
            p,
            region
          ),
          now,
          windowHours
        );
        return await queue(
          until,
          `delivery-rate breaker (${(delivRate * 100).toFixed(0)}% delivered) - number may be soft-restricted`
        );
      }
    }
  }

  // 4. DYNAMIC VOLUME CAPS (velocity vector) - trust-scaled, warm-up ramped,
  //    with a per-day random wobble so a fixed cap is not itself a pattern.
  const jitter = dailyCapJitter(opts.senderKey, p);
  // The hourly cap must NEVER fall below the plan's conversation budget - the
  // downward daily-wobble (0.8x) would otherwise drop a new ultra number's cap
  // to ~32 and split its own 40-intro burst an hour out. Floor it at the budget
  // so the full first-session batch always fits inside one hour.
  const hourCap = Math.max(
    planCapacity(plan).newContacts,
    Math.round(dynamicHourCap(rep, p, plan) * jitter)
  );
  const dayCap = Math.max(1, Math.round(p.day_cap * jitter));
  // STRICT read: an unreadable send history must hold automated sends (fail
  // closed), never count as "0 sent today" (fail open = unlimited sends the
  // moment the DB blips - the exact outage-mode failure the guard exists for).
  const sentRes = await sbSelectStrict<{
    received_at: string;
    to_number: string;
    kind?: string | null;
  }>(
    "whatsapp_messages",
    // `kind` is the outbox row's own meta.kind, spread into `raw` at send time
    // (see the insert at the end of drainOutbox). It is what separates a COLD
    // first-contact ("rfq") from an engaged reply, and the burst guard below
    // needs that separation - without it a cold batch's velocity parks a
    // counter-reply for half an hour.
    `select=received_at,to_number,kind:raw->>kind&direction=eq.outbound&to_number=not.in.(session,takeover,cancel)&raw->>sender=eq.${encodeURIComponent(
      opts.senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=300`
  );
  if ("error" in sentRes && sentRes.error === "unavailable" && opts.auto) {
    return await queue(jitteredHold(now, 5, 5), "sync-retry");
  }
  const sentRows = "rows" in sentRes ? sentRes.rows : [];
  // Count messages ALREADY PARKED in the outbox for this sender toward the
  // HOURLY window (only) when they are actually due within the next hour, so
  // concurrent auto-replies do not all read the same pre-send count and blow
  // past the hourly cap. A batch parked for later must NOT wedge today's
  // replies into the same hold (the cascade that stamped ten messages with one
  // identical ETA). NOTE: parked rows are deliberately NOT counted toward the
  // DAILY cap below - a large legitimately-staggered batch would otherwise trip
  // its OWN daily ceiling (1 sent + 38 parked >= 39) and get almost entirely
  // deferred; concurrency for the daily total is already serialized by the send
  // claims, so the daily cap is a pure ceiling on ACTUAL sends.
  const pendingForSender = await sbSelect<{ id: number; not_before: string }>(
    "wa_outbox",
    `select=id,not_before&sender_key=eq.${encodeURIComponent(opts.senderKey)}&limit=300`
  ).catch(() => []);
  // Count ONLY genuinely-imminent parked rows (due within one min-gap) toward
  // the hourly cap - that is the concurrency case this guard is for (N replies
  // all due NOW each reading the same pre-send count). Counting the whole next
  // HOUR made a deliberately-staggered batch trip its OWN cap: every future
  // sibling was counted, so `sent + pendingDueSoon` hit the cap on the first
  // drain and the drain re-stamped the rest an hour out - the "it said 17:34
  // then jumped to 18:34" bug. A future-scheduled row is not concurrent.
  const dueWindow = new Date(now + Math.max(1, p.min_gap_seconds) * 1000).toISOString();
  const pendingDueSoon = pendingForSender.filter((r) => r.not_before <= dueWindow).length;
  const hourAgo = new Date(now - 3600_000).toISOString();
  const lastHour = sentRows.filter((r) => r.received_at >= hourAgo).length + pendingDueSoon;
  // The hourly cap governs COLD OUTREACH velocity (new first-contacts) - that is
  // the ban vector. A REPLY to an already-engaged shop (one that messaged us) is
  // the safest send there is, and must NOT be throttled just because the user's
  // 40-intro burst already filled this hour - otherwise an engaged shop waits
  // ~an hour for its counter-reply, killing negotiation momentum. Replies stay
  // bounded by the burst window, the min-gap, stealth pacing and the daily cap.
  if (isNewContact && lastHour >= hourCap) {
    // STABLE hold: anchor to when the rolling hour actually frees (the oldest
    // send in the window ages out at oldest+1h), NOT a fresh now+15-35min that
    // every drain re-stamps forward ("came back an hour later, everything
    // moved another 30 min"). sentRows is DESC, so the last in-window row is
    // the oldest.
    const inHour = sentRows.filter((r) => r.received_at >= hourAgo);
    const oldestInHour = inHour.length ? Date.parse(inHour[inHour.length - 1].received_at) : now;
    const freeAt = Math.max(now + 90_000, oldestInHour + 3600_000);
    const jitterMs = Math.floor(Math.random() * 3 * 60_000);
    return await queue(
      new Date(freeAt + jitterMs).toISOString(),
      `hourly cap reached (${hourCap}/h at trust ${rep.trust_score})`
    );
  }
  if (sentRows.length >= dayCap) {
    // QUEUE, never DROP: on the drain path the row was already claimed
    // (deleted), so a bare !allow would silently lose it (the "sent a few then
    // the rest vanished" bug). Anchor the hold to when the rolling 24h window
    // actually frees - the oldest send ages out at oldest+24h - clamped into
    // the shop's business hours, so a capped batch resumes instead of dying.
    const oldest = sentRows.length
      ? Date.parse(sentRows[sentRows.length - 1].received_at)
      : now;
    const freeAt = Math.max(now + 5 * 60_000, oldest + 24 * 3600_000);
    const until = clampToBusinessHours(new Date(freeAt).toISOString(), opts.toDigits, p, region);
    return await queue(until, `daily cap reached (${dayCap}/day) - resumes as capacity frees`);
  }

  // PREDICTIVE STEALTH: how risky does this number look RIGHT NOW? Below the
  // hard pause, a rising score stretches the min-gap and tightens burst - a
  // graduated, self-clearing slowdown that reacts to real feedback before a ban.
  const stealth = stealthFactor(computeRisk(rep, p).score, p.risk_pause_threshold);

  // 5. BURST COOLDOWN - even within caps, N sends in a short window is a robotic
  //    burst. After a burst, enforce a longer rest before the next send.
  //
  //    TWO LANES, TWO BUDGETS. This used to be one counter over every outbound
  //    row, and it was the only real coupling left between cold outreach and
  //    engaged conversation: a 40-intro batch is BUILT to fill a 600s window,
  //    so the moment it did, the next counter-reply inherited a 30-MINUTE
  //    cooldown it had done nothing to earn. That is the Ko Tao shape - shop
  //    quotes at 12:22, our answer lands at 12:39.
  //
  //    A reply to a number that messaged US is not the vector this guard
  //    exists for (unsolicited first contact is), so it is counted on its own
  //    lane, against its own ceiling, and cooled in SECONDS. What still bounds
  //    it: the daily cap above (all sends), the per-recipient min-gap below,
  //    the fleet gap and the recipient mutex in wa/pacing. Nothing was traded
  //    away here - the reply lane simply stopped paying the cold lane's fine.
  const isReply = opts.auto && !isNewContact;
  const burstWindowAgo = new Date(now - p.burst_window_seconds * 1000).toISOString();
  const burstRows = sentRows.filter((r) => r.received_at >= burstWindowAgo);
  const inBurst = burstRows.length;
  // Burst tolerance scales with the plan's hourly headroom; stealth tightens it
  // when the number is in the danger zone. Fresh/low-trust numbers keep the floor.
  const burstMax = Math.max(
    3,
    Math.round(Math.max(p.burst_max_in_window, Math.ceil(hourCap * 0.7)) / stealth)
  );
  if (opts.auto && isReply) {
    // Replies only. A row with no recorded kind predates this field; treat it
    // as cold (the conservative read - it keeps such a row OUT of the reply
    // budget rather than silently inflating it).
    const replyBurst = burstRows.filter((r) => r.kind && r.kind !== "rfq").length;
    // A pathological-loop backstop, not a pacer: at the plan's conversation
    // budget every live thread could legitimately answer twice inside one
    // window. Below this ceiling the fleet gap is what actually paces replies.
    const replyMax = Math.max(burstMax, planCapacity(plan).newContacts * 2);
    if (replyBurst >= replyMax) {
      const newestReply = burstRows.find((r) => r.kind && r.kind !== "rfq");
      const anchor = newestReply ? Date.parse(newestReply.received_at) : now;
      const cool = (45 + Math.random() * 45) * 1000;
      return await queue(
        new Date(Math.max(now, anchor) + cool).toISOString(),
        `reply burst cooldown (${replyBurst} in ${p.burst_window_seconds}s)`
      );
    }
  } else if (opts.auto && inBurst >= burstMax) {
    const newest = sentRows[0] ? Date.parse(sentRows[0].received_at) : now;
    const until = new Date(newest + p.burst_cooldown_minutes * 60_000).toISOString();
    return await queue(until, `burst cooldown (${inBurst} in ${p.burst_window_seconds}s)`);
  }

  // 6. ANTI-ROBOTIC MINIMUM GAP with jitter (never two sends back-to-back). The
  //    gap is stretched by the stealth factor when the number looks risky, so a
  //    wobbling number instantly paces slower without a hard freeze.
  //    REPLY LANE: a counter-reply to an already-engaged shop paces against the
  //    last send TO THAT SHOP - not the sender-global last send - so 40 live
  //    threads never queue behind one another (the "one shop at a time" bug).
  //    A human juggling many chats answers several within a minute; only the
  //    SAME shop is min-gap paced. Cold intros keep the strict per-sender gap.
  let lastSendRefMs = 0;
  if (isReply) {
    const toDig = digitsOnly(opts.toDigits);
    for (const r of sentRows) {
      if (digitsOnly(r.to_number) !== toDig) continue;
      const t = Date.parse(r.received_at);
      if (Number.isFinite(t) && t > lastSendRefMs) lastSendRefMs = t;
    }
  } else if (rep.last_send_at) {
    const t = Date.parse(rep.last_send_at);
    if (Number.isFinite(t)) lastSendRefMs = t;
  }
  if (lastSendRefMs > 0) {
    const gapNeeded = (p.min_gap_seconds + Math.random() * p.gap_jitter_seconds) * 1000 * stealth;
    const since = now - lastSendRefMs;
    if (opts.auto && since < gapNeeded) {
      const reason = stealth > 1.3 ? "easing off to keep your number safe" : "human pacing gap";
      return await queue(new Date(now + (gapNeeded - since)).toISOString(), reason);
    }
  }

  return { allow: true, text };
}

/** Book-keeping after a successful send (trust decay, new-contact count). */
export async function afterSend(senderKey: string, toNumber?: string): Promise<void> {
  await recordOutboundSend(senderKey, toNumber);
}

// ---------------------------------------------------------------------------
// Outbox drain - serverless-friendly queue (no cron needed)
// ---------------------------------------------------------------------------

// The row shape lives with the lifecycle that owns it (wa/outbox-lifecycle) -
// one definition, so a surface reading a row and the drain writing one cannot
// drift apart on what a queued message is.

/**
 * Send every due queued message. Called opportunistically from the inbound
 * webhook and the WA status poll, so the queue drains while the app is alive
 * without a dedicated worker.
 */
/**
 * Is this parked draft still an answer to the conversation as it stands - and
 * if not, drop it AND make sure something else speaks.
 *
 * Returns true when the row was consumed (dropped + re-triggered), false when
 * the caller should carry on and send it.
 *
 * Every read here fails OPEN. A draft that cannot be judged is sent, because
 * the alternative - deleting a correct message because one query blipped -
 * trades a visible failure for an invisible one, and the re-trigger would need
 * the same database that just failed.
 */
async function staleDraftDropped(
  row: { id: number; sender_key: string; to_number: string; meta: unknown },
  rowKind: string | undefined
): Promise<boolean> {
  // Cold introductions answer nothing, and a user's own typed message is theirs
  // to send. Only auto REPLIES can go stale.
  if (rowKind === "rfq" || rowKind === "custom" || rowKind === "human-manual") return false;
  const meta = (row.meta ?? {}) as { composedAgainst?: import("./wa/freshness").ComposedAgainst };
  const composedAgainst = meta.composedAgainst;
  if (!composedAgainst) return false; // parked before this shipped - not our business

  try {
    // ONE ASKER, SHARED WITH THE INLINE SEND PATH (wa/freshness-live.ts). The
    // drain and the in-request send must never disagree about what "stale"
    // means, or a draft refused here would go straight out there.
    const { threadMovedOn } = await import("./wa/freshness-live");
    const verdict = await threadMovedOn({
      senderKey: row.sender_key,
      toNumber: row.to_number,
      composedAgainst,
      kind: rowKind,
    });
    if (!verdict.stale) return false;

    // The row is gone. Say so loudly - a silent drop is how a thread dies.
    await completeOutboxRow(row.id);
    await sbInsert("agent_events", [
      {
        kind: "wa-send-stale",
        user_email: row.sender_key,
        vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
        detail: `${verdict.reason}: ${verdict.detail ?? ""}`.slice(0, 300),
      },
    ]).catch(() => {});

    // ...and make sure the shop still hears from us. The newer inbound may have
    // had no turn of its own; this schedules one, and the wakeup drain applies
    // its own per-thread claim so a turn already in flight is not duplicated.
    const { threadKeyFor } = await import("./graph/state");
    const threadKey = threadKeyFor(row.sender_key, row.to_number);
    const base = {
      kind: "tick",
      thread_key: threadKey,
      not_before: new Date(Date.now() + 2_000).toISOString(),
      payload: { reason: "stale-draft-recompose" },
    };
    const ok = await sbInsert("graph_wakeups", [{ ...base, user_email: row.sender_key }]).catch(
      () => false
    );
    if (!ok) await sbInsert("graph_wakeups", [base]).catch(() => {});
    return true;
  } catch {
    return false; // unreadable => send, never delete on a blip
  }
}

/**
 * What counts as an ENGAGED REPLY, as a PostgREST fragment.
 *
 * One definition, shared by the drain's reply select and the reply
 * dispatcher's "when is the next one due?" probe, so the lane can never
 * disagree with itself about what it is carrying.
 */
export const REPLY_KIND_FILTER = "not.in.(rfq,custom,human-manual)";

export type DrainOptions = {
  /**
   * Carry ONLY engaged replies. The reply dispatcher sets this so a cold batch
   * - however large, however stalled - is not even in its result set.
   */
  replyOnly?: boolean;
  /** Restrict to one user's rows (the reply dispatcher is per-sender). */
  senderKey?: string;
};

export async function drainOutbox(
  send: (
    senderKey: string,
    to: string,
    text: string
  ) => Promise<{ ok: boolean; error?: string; rateLimited?: boolean; unconfirmed?: boolean; messageId?: string }>,
  opts?: DrainOptions
): Promise<number> {
  const due = encodeURIComponent(new Date().toISOString());
  const cols = "select=id,sender_key,to_number,body,not_before,meta";
  const senderFilter = opts?.senderKey
    ? `&sender_key=eq.${encodeURIComponent(opts.senderKey)}`
    : "";
  // TWO SELECTS, AND THE REPLY ONE IS NOT OPTIONAL.
  //
  // There has always been a priority sort below, and its comment has always
  // promised that an engaged shop never waits behind a cold batch. But the sort
  // ran on rows that had already survived a GLOBAL `not_before.asc LIMIT 48`
  // across every user - so once a stalled batch left more than 48 overdue
  // introductions, a fresh reply due seconds ago was not in the list at all and
  // the sort never saw it. A ranking cannot rescue what the query dropped.
  //
  // Asking for replies in their own query makes the promise structural: they
  // are in the pool whatever the cold queue is doing.
  const replyQuery =
    `${cols}&not_before=lte.${due}&meta->>kind=${REPLY_KIND_FILTER}` +
    `${senderFilter}&order=not_before.asc&limit=24`;
  const [replyRows, anyRows] = await Promise.all([
    sbSelect<OutboxRow>("wa_outbox", replyQuery).catch(() => [] as OutboxRow[]),
    // The reply lane runs on its OWN dispatcher (api/wa/reply-tick) and must not
    // touch the cold batch: that is the whole point of a second lane. Only the
    // general drain asks for everything.
    opts?.replyOnly
      ? Promise.resolve([] as OutboxRow[])
      : sbSelect<OutboxRow>(
          "wa_outbox",
          `${cols}&not_before=lte.${due}${senderFilter}&order=not_before.asc&limit=48`
        ),
  ]);
  const byId = new Map<number, OutboxRow>();
  for (const r of [...replyRows, ...anyRows]) byId.set(r.id, r);
  const dueRows = [...byId.values()];
  // PRIORITY: an engaged shop waiting on our reply must never sit behind a cold
  // introductions batch due at the same moment (the "our agents never message
  // back" report). The rule lives in outbox-policy so it is unit-pinned.
  //
  // ...and PLAN breaks the tie inside a kind. Priority processing has been on
  // the Pro and Ultra plan cards since they shipped and was never built: the
  // sort knew about message kind and nothing else, so a paying traveller's
  // reply sat behind a free user's reply that happened to be due a second
  // earlier. It is deliberately a tie-break and not a queue-jump - a paid cold
  // introduction still waits behind anyone's live reply, because an engaged
  // shop is the more urgent thing in the system whoever is paying.
  const { compareOutboxRows, outboxExpired, OUTBOX_MAX_AGE_MS } = await import("./wa/outbox-policy");
  const keyOf = (row: OutboxRow) => {
    const meta = row.meta as { kind?: string; plan?: string } | null;
    return { kind: meta?.kind ?? null, plan: meta?.plan ?? null, notBefore: row.not_before };
  };
  const candidates = [...dueRows].sort((a, b) => compareOutboxRows(keyOf(a), keyOf(b))).slice(0, 30);
  const { claimSendSlots, releaseMessageClaim, gcSendClaims } = await import("./wa/pacing");
  const p = await getPolicies();
  let sent = 0;
  // Per-invocation drain budgets. COLD INTROS (rfq) stay strictly paced per
  // sender (2/invocation) - new-number velocity is the ban vector. REPLIES to
  // engaged shops drain CONCURRENTLY: at most one per shop per invocation (never
  // double-send a shop) up to an overall paced ceiling, so many live threads
  // advance together instead of one-at-a-time. The tick self-chains, so any
  // overflow drains within ~a minute rather than in a burst.
  const isCold = (row: OutboxRow) => (row.meta as { kind?: string } | null)?.kind === "rfq";
  const rfqBySender = new Map<string, number>();
  const replySentToRecipient = new Set<string>();
  // Modest per-invocation reply budget: the ATOMIC fleet gap slot (in
  // claimSendSlots) is the real velocity ceiling now, so a high budget here just
  // churns doomed claims. Frequent invocations (polls + the self-chaining tick)
  // supply the throughput; each drains a few and the fleet gap paces the total.
  let replyBudget = 6;
  for (const cand of candidates) {
    // TOO OLD TO SEND. `not_before <= now` is a floor, not a ceiling: a row
    // overdue by three days passed it exactly as well as one overdue by three
    // seconds. That was survivable while nothing drained automatically. With a
    // scheduler calling this every minute it is not - and the freshness gate
    // cannot save us, because NEVER_STALE exempts cold introductions, so an
    // ancient "do you have one for tomorrow?" is judged fresh and goes out.
    if (outboxExpired(cand.not_before, Date.now())) {
      await completeOutboxRow(cand.id);
      await sbInsert("agent_events", [
        {
          kind: "wa-send-expired",
          vendor_id: String((cand.meta as { vendorId?: string } | null)?.vendorId ?? ""),
          vendor_name: String(
            (cand.meta as { vendorName?: string } | null)?.vendorName ?? cand.to_number
          ),
          detail: `Binned a message to +${cand.to_number} (sender ${cand.sender_key}) that had been due since ${cand.not_before} - older than the ${Math.round(OUTBOX_MAX_AGE_MS / 3600_000)}h ceiling. Sending it now would answer a question the traveller has moved on from.`,
        },
      ]).catch(() => {});
      continue;
    }
    const cold = isCold(cand);
    const rcptKey = `${cand.sender_key}|${digitsOnly(cand.to_number)}`;
    const overCap = cold
      ? (rfqBySender.get(cand.sender_key) ?? 0) >= 2
      : replyBudget <= 0 || replySentToRecipient.has(rcptKey);
    if (overCap) {
      // SMOOTH the remainder so the NEXT drain doesn't instantly fire it either
      // (a slow-motion burst). Cold intros are held 2-4 min - velocity to new
      // numbers is the ban risk. A REPLY is over budget for two reasons only:
      // this invocation's ceiling is spent, or this shop already got a message
      // - and both clear in seconds now that the recipient mutex and the fleet
      // gap are the real pacers. It used to wait 30-90s here for a queueing
      // artefact, on top of everything else, which is how a "reply in seconds"
      // target quietly became minutes.
      await sbUpdate("wa_outbox", `id=eq.${cand.id}`, {
        not_before: cold
          ? jitteredHold(Date.now(), 2, 2)
          : new Date(Date.now() + (RECIPIENT_LOCK_SEC + 2 + Math.random() * 6) * 1000).toISOString(),
      }).catch(() => {});
      continue;
    }
    // ATOMIC CLAIM BY LEASE. This used to be a delete-with-return, which won
    // the race correctly but made the row - and therefore the shop - cease to
    // exist for the whole send. Every surface derives shop state from the outbox
    // and the sent-messages table, so during that window the shop had no state
    // at all and disappeared from the queue and the status panel.
    //
    // A conditional update wins the race exactly as well (the loser
    // re-evaluates `not_before<=now` against the winner's committed row and
    // matches nothing) while leaving the row in place, marked `sending`. It also
    // gives a crashed drainer's message a way back: the lease lapses and the row
    // is simply due again, which the delete made impossible.
    const claimedAt = Date.now();
    if (!(await claimOutboxRow(cand.id, cand.meta as OutboxMeta | null, claimedAt))) continue;
    const row: OutboxRow = { ...cand, meta: { ...(cand.meta ?? {}), claimedAt } };
    /** Hand this row back to the queue at a new time, with an honest reason. */
    const release = (delayMs: number, patch: Record<string, unknown>) =>
      releaseOutboxRow(
        row.id,
        new Date(Date.now() + Math.max(0, delayMs)).toISOString(),
        { ...(cand.meta ?? {}), ...patch } as OutboxMeta
      );
    // Re-check the gate (caps/hours may have changed while queued). Preserve the
    // row's ORIGINAL auto-ness: a user-typed `custom` message that the caps
    // parked is NOT an agent send, so it must not be re-evaluated as auto and
    // dropped by an auto-only veto (the engagement halt is terminal now - a
    // hardcoded auto:true here silently deleted the user's own queued message).
    const rowKind = (row.meta as { kind?: string } | null)?.kind;
    const verdict = await guardOutbound({
      senderKey: row.sender_key,
      toDigits: row.to_number,
      text: row.body,
      auto: rowKind !== "custom",
      queueIfBlocked: true,
      meta: row.meta ?? undefined,
      // The row still EXISTS (claimed by lease, not deleted), so the guard must
      // re-time THIS row rather than insert a second one for the same shop.
      outboxRowId: row.id,
      // B4: row.body was humanized once when it was parked - do NOT re-vary it.
      alreadyHumanized: true,
    });
    if (!verdict.allow) {
      // The gate either RE-QUEUED the row (verdict.queuedUntil set - it patched
      // this row in place) or DELIBERATELY dropped it (verdict.terminal -
      // cancelled / duplicate / rfq-dedup / takeover, where re-sending would be
      // wrong). If it did NEITHER, release the claim so a non-terminal reject
      // can never strand a real send inside a lease.
      const { needsRepark } = await import("./wa/outbox-policy");
      if (verdict.terminal) await completeOutboxRow(row.id);
      else if (needsRepark(verdict)) {
        // A TRANSIENT READ IS NOT A FIVE-MINUTE PROBLEM. This is the fail-closed
        // path: a reputation row, tombstone table or session flag that could not
        // be read, so the guard refused without re-queueing. Under the database
        // load a 40-shop batch generates that is a routine blip, and parking an
        // engaged reply 5-10 minutes for it is the cleanest explanation for the
        // 17- and 21-minute outliers in the field. Cold intros keep the long
        // hold; a reply retries in seconds and fails closed again if the read is
        // genuinely broken.
        const backoff = isCold(cand)
          ? Date.parse(jitteredHold(Date.now(), 5, 5)) - Date.now()
          : (20 + Math.random() * 20) * 1000; // ~20-40s
        await release(backoff, { reason: "sync-retry" });
      }
      continue;
    }
    // Last-instant cancellation re-check (the user may have tapped Remove
    // between the guard verdict and this send).
    try {
      const { isCancelled } = await import("./wa/cancellations");
      if ((await isCancelled(row.sender_key, row.to_number)) === true) {
        await completeOutboxRow(row.id); // the user removed it - it is gone for good
        continue;
      }
    } catch {
      /* the guard already enforced the readable cases */
      await release(60_000, { reason: "sync-retry" });
      continue;
    }

    // IS THIS STILL TRUE? - the one semantic question the send path never asked.
    //
    // Everything above this line is anti-ban, cancellation and pacing. None of
    // it reads the conversation, so a draft written at 12:23 went out at 12:39
    // unchanged, after the shop had said something at 12:38 that made it wrong.
    // A message is a promise made at compose time and kept at send time, and
    // between those two moments the thread can move.
    //
    // DROP AND RECOMPOSE, NEVER DROP AND HOPE. Deleting the row alone would
    // assume the newer inbound ran a turn of its own - and it may not have
    // (guard refusal, takeover flip, LLM outage, vision offload, coalescing).
    // So a stale drop always schedules a fresh turn against the latest inbound.
    if (await staleDraftDropped(row, rowKind)) continue;

    // ATOMIC SEND SLOTS: the guard's time-based checks are read-then-act and
    // N concurrent drainers all pass them together. The claim row is the
    // lock: exactly ONE invocation per min-gap window per sender sends, and
    // exactly one delivery per unique message ever happens.
    const isReplyRow = rowKind !== "rfq" && rowKind !== "custom";
    const claim = await claimSendSlots({
      senderKey: row.sender_key,
      toDigits: row.to_number,
      text: verdict.text,
      auto: true,
      // REPLY lane paces per engaged shop at the tighter reply_gap (~5s); a cold
      // intro (rfq) keeps the strict 12s per-sender velocity lane.
      gapSeconds: isReplyRow ? p.reply_gap_seconds : p.min_gap_seconds,
      // A reply/follow-up to an already-engaged shop paces PER-RECIPIENT, so 40
      // live threads do not serialize through one per-sender window. A cold
      // intro (rfq) keeps the strict per-sender velocity lane. The fleet gap is
      // the atomic ceiling that keeps the fleet a trickle, not a burst.
      perRecipient: isReplyRow,
      fleetGapSeconds: isReplyRow ? replyFleetGapSeconds(p) : undefined,
    });
    if (!claim.ok) {
      if (claim.kind === "duplicate") {
        // Another invocation holds this message's idempotency slot. Usually it
        // is mid-delivery and will retire the row itself - but it may also have
        // DIED holding the slot, so waiting forever is not an option. Hold this
        // row briefly and count the holds; a bounded number of them, then an
        // honest give-up rather than a row that retries until the heat death.
        const holds = Number((cand.meta as OutboxMeta | null)?.dupHolds ?? 0) + 1;
        if (holds >= MAX_DUP_HOLDS) {
          await completeOutboxRow(row.id);
          await sbInsert("agent_events", [
            {
              kind: "wa-send-dropped",
              vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
              vendor_name: String(
                (row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number
              ),
              detail: `Stopped retrying +${row.to_number} (sender ${row.sender_key}) - an identical message held the send slot ${MAX_DUP_HOLDS} times, so it has almost certainly already gone out.`,
            },
          ]).catch(() => {});
        } else {
          await release(120_000, { dupHolds: holds, reason: "human pacing gap" });
        }
        continue;
      }
      // PENALTY PROPORTIONAL TO THE LANE THAT REFUSED.
      //
      // The lanes a reply loses are measured in SECONDS - a 5s per-shop gap, a
      // 6s fleet slot, an 8s recipient mutex - and the penalty for losing one
      // was a flat 1-3 MINUTES. Two losses in a row and a reply that was ready
      // at 12:23 leaves at 12:29. Waiting out the window that refused you is
      // the whole cost; anything beyond it is invented latency.
      //
      // Cold intros keep the minute-scale hold: velocity to new numbers is the
      // ban vector, and their lane is 12s+ anyway.
      const lostLane = isCold(cand)
        ? Date.parse(jitteredHold(Date.now(), 1, 2)) - Date.now()
        : (RECIPIENT_LOCK_SEC + 2 + Math.random() * 4) * 1000; // ~10-14s
      await release(lostLane, {
        reason: claim.kind === "pacing" ? "human pacing gap" : "sync-retry",
      });
      // TWO OPPOSITE CAUSES WROTE THE SAME COUNTER.
      //
      // `claim.kind === "pacing"` means another sender legitimately holds the
      // lane: the system working, the row re-parked for seconds and retried.
      // Anything else is a FAIL-CLOSED refusal - the claim table could not be
      // read, so we declined to send rather than risk a double. That is the
      // send lane being down.
      //
      // Both landed on `claim-lost`, so the one number the owner reads on the
      // dashboard meant either "busy" or "broken" and there was no way to tell
      // which. A contention counter that can also mean an outage is not a
      // signal, and it is the input the adaptive pacing wants to read.
      await sbInsert("agent_events", [
        {
          kind: claim.kind === "pacing" ? "claim-lost" : "claim-error",
          detail: `send slot ${claim.kind} for ${row.sender_key} -> +${row.to_number}`,
        },
      ]).catch(() => {});
      continue;
    }
    // A THROW from send() (e.g. the transport rejected) must not abandon the
    // rest of the batch or lose this already-claimed row - treat it as a
    // transient failure so the branch below re-queues it. With the evoFetch
    // hard timeout in place, a slow host now returns {ok:false} rather than
    // hanging, but this keeps any other throw safe too.
    let r: {
      ok: boolean;
      error?: string;
      rateLimited?: boolean;
      unconfirmed?: boolean;
      messageId?: string;
      chatJid?: string;
    };
    try {
      r = await send(row.sender_key, row.to_number, verdict.text);
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : "send threw" };
    }
    if (r.ok) {
      sent++;
      if (cold) {
        rfqBySender.set(row.sender_key, (rfqBySender.get(row.sender_key) ?? 0) + 1);
      } else {
        replySentToRecipient.add(rcptKey);
        replyBudget--;
      }
      await afterSend(row.sender_key, row.to_number);
      await sbInsert("whatsapp_messages", [
        {
          // STORE THE PROVIDER MESSAGE ID. Without it the webhook's fromMe
          // echo-check ("did WE send this?") could never match by id and fell
          // back to a 10-minute body comparison - so our own humanized send,
          // echoed back late or with varied text, was misfiled as a HUMAN
          // TAKEOVER. That wrote an rfq-less outbound row on top of the thread
          // and every later shop reply died as "no-rfq-thread".
          wa_message_id: r.messageId ?? null,
          to_number: row.to_number,
          body: verdict.text,
          type: "text",
          direction: "outbound",
          // confirmed=false means Evolution accepted the request (2xx) but did
          // not return a delivery receipt - recorded honestly so the UI can show
          // it as "sent, unverified" rather than a confirmed delivery.
          raw: {
            ...(row.meta ?? {}),
            sender: row.sender_key,
            ok: true,
            auto: true,
            queued: true,
            confirmed: r.unconfirmed ? false : true,
            // The chat's privacy identity when the provider reported one. An
            // outbound anchor carrying raw.lid is what lets the shop's FIRST
            // @lid reply resolve (wa/lid-alias reads BOTH directions) - the
            // old inbound-only alias trail needed a previously-successful
            // ingest, a chicken-and-egg that dropped the opening reply of
            // every privacy-migrated thread.
            ...(lidKey(r.chatJid) ? { lid: lidKey(r.chatJid) } : {}),
          },
        },
      ]);
      // ORDER MATTERS, and it is the whole point of this lifecycle: the SENT row
      // is written FIRST, and only then is the queued row retired. The shop is
      // briefly in both tables (every surface prefers "sent"), and never in
      // neither - which is what made it disappear mid-send.
      await completeOutboxRow(row.id);
      if (r.unconfirmed) {
        await sbInsert("agent_events", [
          {
            kind: "wa-send-unconfirmed",
            vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
            vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
            detail: `Sent to +${row.to_number} (sender ${row.sender_key}) but WhatsApp returned no delivery receipt - shown as unverified.`,
          },
        ]).catch(() => {});
      }
    } else {
      // Release the idempotency claim - the retry below must not be treated
      // as a duplicate of the failed attempt.
      await releaseMessageClaim(row.sender_key, row.to_number, verdict.text).catch(() => {});
      // CLASSIFY the failure. A TRANSIENT infra failure (the Evolution host is
      // waking/restarting/timed-out - the "wd-evolution health check failed"
      // case) is NOT the recipient's fault and must NOT burn the retry cap or
      // creep the ETA 10/20/30/40/50 min into the future (that is exactly what
      // made a whole batch stall after one send and then silently vanish).
      // Only RECIPIENT-level failures (not on WhatsApp, invalid, blocked) count
      // toward the give-up cap.
      const { isRecipientSendFailure, transientRetryDecision, recipientRetryDecision } =
        await import("./wa/send-classify");
      const recipientFail = isRecipientSendFailure(r.error);
      const transient = !recipientFail; // reconnecting / timeout / 5xx / empty / unknown host error
      const dropEvent = (detail: string) =>
        sbInsert("agent_events", [
          {
            kind: "wa-send-dropped",
            vendor_id: String((row.meta as { vendorId?: string } | null)?.vendorId ?? ""),
            vendor_name: String((row.meta as { vendorName?: string } | null)?.vendorName ?? row.to_number),
            detail,
          },
        ]).catch(() => {});
      if (transient) {
        // Retry SOON with no per-failure attempt burn - the batch resumes within
        // ~a minute of the host recovering. Bounded lifetime lives in the pure
        // decision helper so a PERMANENTLY dead host cannot loop forever.
        const meta = (row.meta ?? {}) as { firstQueuedAt?: number; transientAttempts?: number };
        const firstQueuedAt = Number(meta.firstQueuedAt) || Date.now();
        const decision = transientRetryDecision(
          firstQueuedAt,
          Number(meta.transientAttempts ?? 0),
          Date.now(),
          Math.random(),
        );
        if (decision.drop) {
          await completeOutboxRow(row.id);
          await dropEvent(
            `Gave up reaching +${row.to_number} - the WhatsApp host was unreachable for over 24h (sender ${row.sender_key}).`,
          );
        } else {
          // The row never left the table, so there is no insert that can fail
          // and silently lose the message - releasing it IS the re-queue.
          await release(decision.delayMs, {
            firstQueuedAt,
            transientAttempts: decision.attempts,
            reason: "reconnecting - resumes automatically",
          });
        }
      } else {
        const decision = recipientRetryDecision(
          Number((row.meta as { attempts?: number } | null)?.attempts ?? 0),
        );
        if (decision.drop) {
          await completeOutboxRow(row.id);
          await dropEvent(
            `Could not reach +${row.to_number} after 5 attempts (sender ${row.sender_key}) - the shop's number may be unreachable on WhatsApp.`,
          );
        } else {
          // Recipient-level retry backoff, capped so it never creeps past
          // ~20 min even at the last attempt.
          await release(decision.delayMs, {
            attempts: decision.attempts,
            reason: `couldn't reach this shop - retry ${decision.attempts}/5`,
          });
        }
      }
    }
  }
  // Housekeeping: stale claim rows expire after 24h (cheap ranged delete).
  // GC RUNS ON EVERY DRAIN, INCLUDING THE QUIET ONES.
  //
  // This was gated on `candidates.length > 0`, so the claims table was only
  // ever collected while there was something to send - and a quiet period is
  // exactly when nothing else exercises the table and the expired rows have
  // most time to pile up. The GC is two ranged deletes with no rows to transfer;
  // running it on an empty drain costs nothing and closes the window where the
  // only thing keeping the table bounded is the traffic that fills it.
  await gcSendClaims();
  return sent;
}

/**
 * Claim the atomic send slots for a DIRECT send (routes that bypass
 * drainOutbox). Policies stay internal to this module - callers only learn
 * the outcome. See src/lib/wa/pacing.ts for semantics.
 */
export async function claimForSend(
  senderKey: string,
  toDigits: string,
  text: string,
  auto: boolean,
  perRecipient = false
): Promise<import("./wa/pacing").ClaimOutcome> {
  const p = await getPolicies();
  const { claimSendSlots } = await import("./wa/pacing");
  return claimSendSlots({
    senderKey,
    toDigits,
    text,
    auto,
    // Engaged replies (perRecipient) use the tighter reply lane; cold keep 12s.
    gapSeconds: perRecipient ? p.reply_gap_seconds : p.min_gap_seconds,
    perRecipient,
    fleetGapSeconds: perRecipient ? replyFleetGapSeconds(p) : undefined,
  });
}

/**
 * The atomic fleet-wide gap for the REPLY lane: a smaller gap than the cold
 * per-sender min-gap (so engaged shops trickle out fast), floored so one number
 * can never emit a machine-gun burst - a person juggling many chats replies
 * quickly but not dozens-per-second.
 */
function replyFleetGapSeconds(p: SecurityPolicies): number {
  return Math.max(5, Math.round((p.min_gap_seconds || 12) / 2));
}

/** Release a message claim after a failed direct send (retry-friendly). */
export async function releaseSendClaim(
  senderKey: string,
  toDigits: string,
  text: string
): Promise<void> {
  const { releaseMessageClaim } = await import("./wa/pacing");
  await releaseMessageClaim(senderKey, toDigits, text);
}

// ---------------------------------------------------------------------------
// Read-only safety surface for the UI (item: anti-ban VISIBILITY).
// Zero behaviour change - this only REPORTS what the guard above is doing, so
// the app can stop saying "connected" while sending is actually paused.
// ---------------------------------------------------------------------------

export interface SenderSafety {
  state: "healthy" | "pacing" | "paused" | "recovering" | "disconnected" | "attention";
  /** RAW internal reason - admin surfaces only, never shown to travellers. */
  reason?: string;
  /** Calm, outcome-language explanation safe for the traveller UI. */
  publicReason?: string;
  pausedUntil?: string;
  trustScore: number;
  riskScore: number;
  queued: number;
  queueReasons: string[];
  /** Traveller-safe translations of queueReasons (same order, deduped). */
  publicQueueReasons: string[];
  /** The raw inputs the verdict was computed from (admin/doctor surfaces). */
  signals?: import("./wa/safety-signals").SafetySignals;
}

// The signal collection runs on every activity poll, so it is cached briefly
// per sender (the same 20-30s currency every other health read accepts).
const safetySignalCache = new Map<
  string,
  { at: number; sig: import("./wa/safety-signals").SafetySignals }
>();

/** The IMPURE half of the health verdict: gather the signals that actually
 * fail in production. Every read degrades to null/0, and the pure classifier
 * only flags on positive evidence - a DB blip cannot paint a number red. */
async function collectSafetySignals(
  senderKey: string
): Promise<import("./wa/safety-signals").SafetySignals> {
  const cached = safetySignalCache.get(senderKey);
  if (cached && Date.now() - cached.at < 20_000) return cached.sig;
  const enc = encodeURIComponent(senderKey);
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { isLoudDrop } = await import("./wa/safety-signals");
  const { instanceNameFor } = await import("./evolution");
  const [sess, hookOk, lastIn, lastOut, drops] = await Promise.all([
    sbSelect<{ status: string | null }>(
      "wa_sessions",
      `select=status&email=eq.${enc}&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-ok&vendor_name=eq.${encodeURIComponent(
        instanceNameFor(senderKey)
      )}&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&order=received_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ kind: string; detail: string | null }>(
      "agent_events",
      `select=kind,detail&kind=in.("inbound-dropped","send-dropped")&user_email=eq.${enc}&created_at=gte.${encodeURIComponent(
        dayAgo
      )}&limit=60`
    ).catch(() => []),
  ]);
  let inboundDropped24h = 0;
  let sendDropped24h = 0;
  for (const d of drops) {
    let reason = "";
    try {
      reason = String(JSON.parse(d.detail ?? "{}").reason ?? "");
    } catch {}
    if (d.kind === "send-dropped") sendDropped24h += 1;
    else if (isLoudDrop(reason)) inboundDropped24h += 1;
  }
  const sig = {
    connection: sess[0]?.status ?? null,
    lastWebhookOkAt: hookOk[0]?.created_at ?? null,
    lastInboundAt: lastIn[0]?.received_at ?? null,
    lastOutboundAt: lastOut[0]?.received_at ?? null,
    inboundDropped24h,
    sendDropped24h,
  };
  if (safetySignalCache.size > 2000) safetySignalCache.clear();
  safetySignalCache.set(senderKey, { at: Date.now(), sig });
  return sig;
}

export async function senderSafety(senderKey: string): Promise<SenderSafety> {
  const [rep, outbox, signals] = await Promise.all([
    getReputation(senderKey).catch(() => null),
    sbSelect<{ meta: { reason?: string } | null }>(
      "wa_outbox",
      `select=meta&sender_key=eq.${encodeURIComponent(senderKey)}&limit=50`
    ).catch(() => [] as { meta: { reason?: string } | null }[]),
    collectSafetySignals(senderKey).catch(() => null),
  ]);

  const queued = outbox.length;
  const queueReasons = [
    ...new Set(outbox.map((r) => r.meta?.reason).filter((x): x is string => Boolean(x))),
  ].slice(0, 4);

  const trustScore = rep?.trust_score ?? 20;
  const riskScore = rep?.risk_score ?? 0;
  const pausedUntil =
    rep?.paused_until && Date.parse(rep.paused_until) > Date.now()
      ? rep.paused_until
      : undefined;

  // Traveller-safe translations: outcome language only (what happens and
  // when), never the mechanism ("ban risk", cap math, trust scores). The raw
  // reasons stay on the object for admin surfaces.
  const { queueReasonLabel } = await import("./queue-reason");
  const publicQueueReasons = [...new Set(queueReasons.map((r) => queueReasonLabel(r)))];

  if (pausedUntil) {
    // Ban recovery drops trust to 10 (enterBanRecovery); a plain risk pause
    // keeps whatever trust the number had.
    const recovering = trustScore <= 10;
    return {
      state: recovering ? "recovering" : "paused",
      reason: recovering
        ? "recovering after a ban-risk signal - all automated sends are held while your number cools down"
        : "sending paused automatically to protect your number from ban risk",
      publicReason:
        "Sending is taking a short break and resumes automatically - your queued messages are safe.",
      pausedUntil,
      trustScore,
      riskScore,
      queued,
      queueReasons,
      publicQueueReasons,
      signals: signals ?? undefined,
    };
  }
  // The verdict layer that used to not exist: a dead connection or real drop
  // events outrank "the queue is empty". During the incident the queue was
  // CANCELLED empty while every reply bounced - and the banner showed green
  // precisely because nothing was queued.
  if (signals) {
    const { classifySafety } = await import("./wa/safety-signals");
    const flag = classifySafety(signals, Date.now());
    if (flag) {
      return {
        state: flag.state,
        reason: flag.reason,
        publicReason: flag.publicReason,
        trustScore,
        riskScore,
        queued,
        queueReasons,
        publicQueueReasons,
        signals,
      };
    }
  }
  if (queued > 0) {
    return {
      state: "pacing",
      reason:
        queueReasons[0] ??
        "messages are queued and will send at a safe, human pace",
      publicReason:
        "Your agent is sending messages at a natural, human pace - each one goes out automatically.",
      trustScore,
      riskScore,
      queued,
      queueReasons,
      publicQueueReasons,
      signals: signals ?? undefined,
    };
  }
  return {
    state: "healthy",
    trustScore,
    riskScore,
    queued,
    queueReasons,
    publicQueueReasons,
    signals: signals ?? undefined,
  };
}
