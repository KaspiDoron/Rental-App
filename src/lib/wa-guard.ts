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
import { sbSelect, sbInsert, sbUpdate } from "./runtime-config";

// ---------------------------------------------------------------------------
// Policies - DB-driven control panel with safe defaults
// ---------------------------------------------------------------------------

export interface SecurityPolicies {
  base_hour_cap: number;        // messages/hour at trust 0
  max_hour_cap: number;         // messages/hour at trust 100
  day_cap: number;              // absolute per-day ceiling
  min_gap_seconds: number;      // min seconds between two sends (jittered up)
  gap_jitter_seconds: number;   // random extra gap 0..N
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
}

const DEFAULTS: SecurityPolicies = {
  base_hour_cap: 4,
  max_hour_cap: 14,
  day_cap: 40,
  min_gap_seconds: 50,
  gap_jitter_seconds: 70,
  warmup_days: 7,
  business_hour_start: 9,
  business_hour_end: 20,
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
  burst_window_seconds: 600,
  burst_max_in_window: 5,
  burst_cooldown_minutes: 30,
  require_number_on_whatsapp: true,
  daily_cap_jitter_pct: 20,
};

declare global {
  // eslint-disable-next-line no-var
  var __wd_wa_policies__: { at: number; value: SecurityPolicies } | undefined;
}

export async function getPolicies(): Promise<SecurityPolicies> {
  const cached = globalThis.__wd_wa_policies__;
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const rows = await sbSelect<{ key: string; value: string }>(
    "whatsapp_security_policies",
    "select=key,value&limit=50"
  );
  const merged: SecurityPolicies = { ...DEFAULTS };
  for (const r of rows) {
    const k = r.key as keyof SecurityPolicies;
    if (!(k in DEFAULTS)) continue;
    if (typeof DEFAULTS[k] === "boolean") {
      (merged as unknown as Record<string, unknown>)[k] = r.value === "true";
    } else {
      const n = Number(r.value);
      if (Number.isFinite(n)) (merged as unknown as Record<string, unknown>)[k] = n;
    }
  }
  globalThis.__wd_wa_policies__ = { at: Date.now(), value: merged };
  return merged;
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
  const age = ageDaysOf(rep);
  if (age >= p.warmup_days) return 1;
  return Math.min(1, (age + 1) / Math.max(1, p.warmup_days));
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

/** Hourly budget scales with trust AND the warm-up ramp (velocity vector). */
export function dynamicHourCap(rep: Reputation, p: SecurityPolicies): number {
  const t = Math.max(0, Math.min(100, rep.trust_score));
  const base = p.base_hour_cap + ((p.max_hour_cap - p.base_hour_cap) * t) / 100;
  const cap = base * warmupMultiplier(rep, p);
  return Math.max(1, Math.round(cap));
}

/** Cold first-contacts allowed today (warm-up ramped). */
function newContactCap(rep: Reputation, p: SecurityPolicies): number {
  return Math.max(1, Math.round(p.max_new_contacts_per_day * warmupMultiplier(rep, p)));
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
// Recipient business hours - country code -> rough UTC offset
// ---------------------------------------------------------------------------

// Phone prefix -> representative UTC offset (hours). Coarse is fine: the goal
// is "never message a shop at 3 AM", not astronomy. Longer prefixes first so
// "972" (Israel) wins over "9", and "1" (US/CA) stays last.
const PREFIX_UTC: [string, number][] = [
  ["972", 2], // Israel
  ["351", 0], // Portugal
  ["66", 7], // Thailand
  ["62", 8], // Indonesia (Bali)
  ["84", 7], // Vietnam
  ["91", 5.5], // India
  ["81", 9], // Japan
  ["82", 9], // South Korea
  ["63", 8], // Philippines
  ["60", 8], // Malaysia
  ["65", 8], // Singapore
  ["86", 8], // China
  ["852", 8], // Hong Kong
  ["886", 8], // Taiwan
  ["90", 3], // Turkey
  ["971", 4], // UAE
  ["966", 3], // Saudi
  ["20", 2], // Egypt
  ["212", 1], // Morocco
  ["27", 2], // South Africa
  ["254", 3], // Kenya
  ["94", 5.5], // Sri Lanka
  ["977", 5.75], // Nepal
  ["52", -6], // Mexico
  ["55", -3], // Brazil
  ["54", -3], // Argentina
  ["57", -5], // Colombia
  ["51", -5], // Peru
  ["56", -4], // Chile
  ["61", 10], // Australia (east)
  ["64", 12], // New Zealand
  ["44", 0], // UK
  ["34", 1], ["39", 1], ["33", 1], ["49", 1], ["30", 2], ["31", 1],
  ["48", 1], ["420", 1], ["36", 1], ["46", 1], ["47", 1], ["45", 1], ["7", 3],
  ["1", -5], // US/CA (east-coast bias)
];

// Region-string -> UTC offset. More reliable than a bare local number, because
// the geocoded region almost always ends in the country name.
const REGION_UTC: [RegExp, number][] = [
  [/\bthai|\bthailand/i, 7], [/\bindonesia|\bbali/i, 8], [/\bvietnam/i, 7],
  [/\bindia\b|\bgoa\b/i, 5.5], [/\bjapan/i, 9], [/\bkorea/i, 9],
  [/\bphilippin/i, 8], [/\bmalaysia/i, 8], [/\bsingapore/i, 8],
  [/\bchina\b/i, 8], [/\bhong kong/i, 8], [/\btaiwan/i, 8],
  [/\bturkey|\btürkiye/i, 3], [/\bemirates|\bdubai|\buae\b/i, 4], [/\bsaudi/i, 3],
  [/\begypt/i, 2], [/\bmorocco/i, 1], [/\bsouth africa/i, 2], [/\bkenya/i, 3],
  [/\bsri lanka/i, 5.5], [/\bnepal/i, 5.75], [/\bisrael/i, 2],
  [/\bmexico/i, -6], [/\bbrazil|\bbrasil/i, -3], [/\bargentin/i, -3],
  [/\bcolombia/i, -5], [/\bperu/i, -5], [/\bchile/i, -4],
  [/\baustralia/i, 10], [/\bnew zealand/i, 12],
  [/\bunited kingdom|\bengland|\bscotland|\bwales|\blondon/i, 0],
  [/\bportugal/i, 0], [/\bspain|\bitaly|\bfrance|\bgermany|\bnetherlands|\bbelgium|\baustria|\bpoland|\bczech|\bhungary/i, 1],
  [/\bgreece\b/i, 2], [/\bsweden|\bnorway|\bdenmark/i, 1], [/\brussia|\bmoscow/i, 3],
  [/\bunited states|\busa\b|\bcanada/i, -5],
];

// Returns the offset AND whether we actually know it (unknown => never queue on
// hours; a false "closed" is worse UX than a rare off-hours send).
function resolveOffset(digits: string, region?: string): { off: number; known: boolean } {
  for (const [prefix, off] of PREFIX_UTC) {
    if (digits.startsWith(prefix)) return { off, known: true };
  }
  if (region) {
    for (const [re, off] of REGION_UTC) if (re.test(region)) return { off, known: true };
  }
  return { off: 0, known: false };
}

/** Recipient's local hour right now (0-23, fractional offsets floored). */
export function recipientLocalHour(toDigits: string, region?: string): number {
  const { off } = resolveOffset(toDigits, region);
  const h = (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
  return Math.floor(h);
}

/** Next moment the recipient's business window opens, as ISO string. */
function nextBusinessOpen(toDigits: string, p: SecurityPolicies, region?: string): string {
  const { off } = resolveOffset(toDigits, region);
  const now = new Date();
  const localHour = (now.getUTCHours() + now.getUTCMinutes() / 60 + off + 24) % 24;
  let waitHours: number;
  if (localHour < p.business_hour_start) {
    waitHours = p.business_hour_start - localHour;
  } else {
    waitHours = 24 - localHour + p.business_hour_start;
  }
  // Add 0-40 min of jitter so queued sends don't all fire at 9:00:00 sharp.
  const jitterMs = Math.floor(Math.random() * 40 * 60_000);
  return new Date(now.getTime() + waitHours * 3600_000 + jitterMs).toISOString();
}

// ---------------------------------------------------------------------------
// Content variance - unique payload signature every time
// ---------------------------------------------------------------------------

const GREET_SWAPS: [RegExp, string[]][] = [
  [/^hi!?\s/i, ["Hi! ", "Hey! ", "Hello! ", "Hi there! ", "Hey there! "]],
  [/\bthanks!?$/i, ["Thanks!", "Thank you!", "Cheers!", "Thanks a lot!"]],
];

/**
 * Semantic variance for AUTOMATED messages: swap greetings/sign-offs, vary
 * contractions and spacing so the payload hash is unique per send while the
 * meaning stays identical. (LLM-composed messages are already unique - this
 * is the guarantee for deterministic/template fallbacks.)
 */
export function humanizeVariant(text: string): string {
  let out = text;
  for (const [rx, pool] of GREET_SWAPS) {
    if (rx.test(out)) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      out = out.replace(rx, /!?$/.test(pick) && rx.source.includes("thanks") ? pick : pick);
    }
  }
  // Contraction jitter (one direction only, keeps grammar safe).
  if (Math.random() < 0.5) out = out.replace(/\bI am\b/g, "I'm");
  if (Math.random() < 0.4) out = out.replace(/\bwhat is\b/gi, (m) => (m[0] === "W" ? "What's" : "what's"));
  if (Math.random() < 0.3) out = out.replace(/\bokay\b/gi, "ok");
  // Punctuation/spacing jitter - invisible to a human, new hash every time.
  if (Math.random() < 0.35) out = out.replace(/\. /g, ".  ");
  if (Math.random() < 0.3 && !/[?!]$/.test(out)) out = out.replace(/\.$/, "");
  // Rare, self-corrected typo (research: a ~2.5% typo rate reads as a real
  // human and breaks hash-matching). We append a natural correction rather
  // than send a misspelled word, so the shop still reads clean intent.
  if (Math.random() < 0.025) {
    const words = out.split(" ");
    const i = words.findIndex((w) => w.length >= 4 && /^[a-z]+$/i.test(w));
    if (i >= 0) {
      const w = words[i];
      const typo = w.slice(0, 1) + w.slice(2, 3) + w.slice(1, 2) + w.slice(3); // swap 2 chars
      out = out.replace(w, `${typo} ${w}`);
    }
  }
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
// The gate - every automated outbound passes through here
// ---------------------------------------------------------------------------

export interface GuardVerdict {
  allow: boolean;
  reason?: string;
  queuedUntil?: string; // set when the message was parked in wa_outbox
  text: string;         // the (possibly varied) payload to actually send
}

/**
 * Decide whether an outbound WhatsApp message may go out RIGHT NOW.
 * `auto` marks agent-generated messages (strictest rules); user-typed custom
 * messages skip the engagement halt but still respect volume caps.
 */
export async function guardOutbound(opts: {
  senderKey: string; // user email (one connected WA number per user)
  toDigits: string;
  text: string;
  auto: boolean;
  queueIfBlocked?: boolean; // park in wa_outbox instead of rejecting
  region?: string;          // geocoded shop region - best timezone source
  shopOpenNow?: boolean;    // Google "open now" truth - overrides the clock
  meta?: Record<string, unknown>; // thread context for queued sends
}): Promise<GuardVerdict> {
  const region = opts.region ?? (typeof opts.meta?.region === "string" ? (opts.meta.region as string) : undefined);
  const p = await getPolicies();
  const text = opts.auto ? humanizeVariant(opts.text) : opts.text;
  const now = Date.now();
  const rep = await getReputation(opts.senderKey);

  const queue = async (notBefore: string, reason: string): Promise<GuardVerdict> => {
    if (opts.queueIfBlocked !== false) {
      await sbInsert("wa_outbox", [
        {
          sender_key: opts.senderKey,
          to_number: opts.toDigits,
          body: text,
          not_before: notBefore,
          // Keep the human reason with the row so the queue viewer explains why.
          meta: { ...(opts.meta ?? {}), reason },
        },
      ]);
      return { allow: false, reason: `${reason} - queued`, queuedUntil: notBefore, text };
    }
    return { allow: false, reason, text };
  };

  // Is this a brand-new cold contact (no prior message to this number)?
  const priorRecipient = await sbSelect<{ id: number }>(
    "wa_recipient_state",
    `select=id&sender_key=eq.${encodeURIComponent(opts.senderKey)}&to_number=eq.${encodeURIComponent(
      opts.toDigits
    )}&limit=1`
  );
  const isNewContact = priorRecipient.length === 0;

  // 0. GLOBAL ACCOUNT PAUSE - a number the risk engine (or a real WhatsApp
  //    restriction) has quarantined sends nothing until the pause expires.
  //    This is the graduated ban-recovery guard from the research.
  if (rep.paused_until && Date.parse(rep.paused_until) > now) {
    if (opts.auto) return await queue(rep.paused_until, "number paused (ban-risk recovery)");
    return { allow: false, reason: "This number is paused for safety recovery.", text };
  }

  // 1. TWO-WAY ENGAGEMENT HALT. Never send a second AUTOMATED message to a
  //    number until it has engaged - a reply OR at least a read receipt (blue
  //    tick). Delivered-but-ignored contacts are the #1 spam signal, so we do
  //    NOT keep pushing them.
  if (opts.auto && p.engagement_halt && !isNewContact) {
    const lastOut = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&to_number=eq.${encodeURIComponent(
        opts.toDigits
      )}&order=received_at.desc&limit=1`
    );
    if (lastOut[0]) {
      const inboundSince = await sbSelect<{ id: number }>(
        "whatsapp_messages",
        `select=id&direction=eq.inbound&from_number=eq.${encodeURIComponent(
          opts.toDigits
        )}&received_at=gte.${encodeURIComponent(lastOut[0].received_at)}&limit=1`
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
        return {
          allow: false,
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
  if (opts.auto && opts.shopOpenNow !== true) {
    const { off, known } = resolveOffset(opts.toDigits, region);
    if (opts.shopOpenNow === false) {
      return await queue(nextBusinessOpen(opts.toDigits, p, region), "shop is closed now");
    }
    if (known) {
      const localHour =
        (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
      const inWindow = localHour >= p.business_hour_start && localHour < p.business_hour_end;
      if (!inWindow) {
        return await queue(
          nextBusinessOpen(opts.toDigits, p, region),
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
    const today = new Date().toISOString().slice(0, 10);
    const newToday = rep.new_contacts_date === today ? rep.new_contacts_today || 0 : 0;
    const capNew = newContactCap(rep, p);
    if (newToday >= capNew) {
      return await queue(
        new Date(now + 60 * 60_000).toISOString(),
        `daily new-contact cap reached (${capNew}/day)`
      );
    }
    // Reply-rate breaker: if we have enough history and almost nobody replies,
    // freeze cold outreach - this is what actually trips WhatsApp's filters.
    if ((rep.sent_total || 0) >= p.min_reply_samples && replyRate(rep) < p.min_reply_rate) {
      return {
        allow: false,
        reason: `reply-rate circuit breaker (${(replyRate(rep) * 100).toFixed(0)}% < ${(p.min_reply_rate * 100).toFixed(0)}%) - cold outreach frozen to protect the number`,
        text,
      };
    }
    // Delivery-rate breaker (research: double-tick threshold ~60%).
    if ((rep.delivered_total || 0) >= 8) {
      const delivRate = (rep.delivered_total || 0) / Math.max(1, rep.sent_total || 0);
      if (delivRate < 0.6) {
        return {
          allow: false,
          reason: `delivery-rate breaker (${(delivRate * 100).toFixed(0)}% delivered) - number may be soft-restricted`,
          text,
        };
      }
    }
  }

  // 4. DYNAMIC VOLUME CAPS (velocity vector) - trust-scaled, warm-up ramped,
  //    with a per-day random wobble so a fixed cap is not itself a pattern.
  const jitter = dailyCapJitter(opts.senderKey, p);
  const hourCap = Math.max(1, Math.round(dynamicHourCap(rep, p) * jitter));
  const dayCap = Math.max(1, Math.round(p.day_cap * jitter));
  const sentRows = await sbSelect<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      opts.senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=300`
  );
  const hourAgo = new Date(now - 3600_000).toISOString();
  const lastHour = sentRows.filter((r) => r.received_at >= hourAgo).length;
  if (lastHour >= hourCap) {
    return await queue(
      new Date(now + 15 * 60_000).toISOString(),
      `hourly cap reached (${hourCap}/h at trust ${rep.trust_score})`
    );
  }
  if (sentRows.length >= dayCap) {
    return { allow: false, reason: `daily cap reached (${dayCap}/day)`, text };
  }

  // 5. BURST COOLDOWN - even within caps, N sends in a short window is a robotic
  //    burst. After a burst, enforce a longer rest before the next send.
  const burstWindowAgo = new Date(now - p.burst_window_seconds * 1000).toISOString();
  const inBurst = sentRows.filter((r) => r.received_at >= burstWindowAgo).length;
  if (opts.auto && inBurst >= p.burst_max_in_window) {
    const newest = sentRows[0] ? Date.parse(sentRows[0].received_at) : now;
    const until = new Date(newest + p.burst_cooldown_minutes * 60_000).toISOString();
    return await queue(until, `burst cooldown (${inBurst} in ${p.burst_window_seconds}s)`);
  }

  // 6. ANTI-ROBOTIC MINIMUM GAP with jitter (never two sends back-to-back).
  if (rep.last_send_at) {
    const gapNeeded = (p.min_gap_seconds + Math.random() * p.gap_jitter_seconds) * 1000;
    const since = now - Date.parse(rep.last_send_at);
    if (opts.auto && since < gapNeeded) {
      return await queue(new Date(now + (gapNeeded - since)).toISOString(), "human pacing gap");
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

interface OutboxRow {
  id: number;
  sender_key: string;
  to_number: string;
  body: string;
  not_before: string;
  meta: Record<string, unknown> | null;
}

/**
 * Send every due queued message. Called opportunistically from the inbound
 * webhook and the WA status poll, so the queue drains while the app is alive
 * without a dedicated worker.
 */
export async function drainOutbox(
  send: (senderKey: string, to: string, text: string) => Promise<{ ok: boolean }>
): Promise<number> {
  const due = await sbSelect<OutboxRow>(
    "wa_outbox",
    `select=id,sender_key,to_number,body,not_before,meta&not_before=lte.${encodeURIComponent(
      new Date().toISOString()
    )}&order=not_before.asc&limit=5`
  );
  let sent = 0;
  for (const row of due) {
    // Delete FIRST so a crash can only lose a message, never double-send it.
    const { sbDelete } = await import("./runtime-config");
    await sbDelete("wa_outbox", `id=eq.${row.id}`);
    // Re-check the gate (caps/hours may have changed while queued).
    const verdict = await guardOutbound({
      senderKey: row.sender_key,
      toDigits: row.to_number,
      text: row.body,
      auto: true,
      queueIfBlocked: true,
      meta: row.meta ?? undefined,
    });
    if (!verdict.allow) continue; // re-queued or dropped by the gate
    const r = await send(row.sender_key, row.to_number, verdict.text);
    if (r.ok) {
      sent++;
      await afterSend(row.sender_key, row.to_number);
      await sbInsert("whatsapp_messages", [
        {
          to_number: row.to_number,
          body: verdict.text,
          type: "text",
          direction: "outbound",
          raw: { ...(row.meta ?? {}), sender: row.sender_key, auto: true, queued: true },
        },
      ]);
    }
  }
  return sent;
}
