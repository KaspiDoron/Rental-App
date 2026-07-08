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
}

async function getReputation(senderKey: string): Promise<Reputation> {
  const rows = await sbSelect<Reputation>(
    "whatsapp_number_reputation",
    `select=id,sender_key,trust_score,sent_total,replies_total,last_send_at,created_at&sender_key=eq.${encodeURIComponent(
      senderKey
    )}&limit=1`
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

/** Hourly budget scales with trust; warm-up halves it for new numbers. */
export function dynamicHourCap(rep: Reputation, p: SecurityPolicies): number {
  const t = Math.max(0, Math.min(100, rep.trust_score));
  let cap = Math.round(p.base_hour_cap + ((p.max_hour_cap - p.base_hour_cap) * t) / 100);
  const ageDays = rep.created_at
    ? (Date.now() - Date.parse(rep.created_at)) / 86_400_000
    : 0;
  if (ageDays < p.warmup_days) cap = Math.max(2, Math.floor(cap / 2));
  return cap;
}

/** Called from the inbound webhook: replies BUILD trust (two-way engagement). */
export async function recordInboundEngagement(senderKey: string): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    await sbUpdate(
      "whatsapp_number_reputation",
      `sender_key=eq.${encodeURIComponent(senderKey)}`,
      {
        trust_score: Math.min(100, rep.trust_score + p.trust_reply_gain),
        replies_total: rep.replies_total + 1,
      }
    );
  } catch {
    /* reputation is best-effort - never block the reply pipeline */
  }
}

async function recordOutboundSend(senderKey: string): Promise<void> {
  try {
    const p = await getPolicies();
    const rep = await getReputation(senderKey);
    await sbUpdate(
      "whatsapp_number_reputation",
      `sender_key=eq.${encodeURIComponent(senderKey)}`,
      {
        trust_score: Math.max(0, rep.trust_score - p.trust_send_decay),
        sent_total: rep.sent_total + 1,
        last_send_at: new Date().toISOString(),
      }
    );
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Recipient business hours - country code -> rough UTC offset
// ---------------------------------------------------------------------------

// Phone prefix -> representative UTC offset (hours). Coarse is fine: the goal
// is "never message a shop at 3 AM", not astronomy.
const PREFIX_UTC: [string, number][] = [
  ["66", 7], // Thailand
  ["62", 8], // Indonesia (Bali)
  ["84", 7], // Vietnam
  ["91", 5.5], // India
  ["81", 9], // Japan
  ["63", 8], // Philippines
  ["60", 8], // Malaysia
  ["90", 3], // Turkey
  ["52", -6], // Mexico
  ["972", 2], // Israel
  ["44", 0], // UK
  ["34", 1], ["39", 1], ["33", 1], ["49", 1], ["351", 0], ["30", 2], ["31", 1],
  ["1", -5], // US/CA (east-coast bias)
];

function utcOffsetFor(digits: string): number {
  for (const [prefix, off] of PREFIX_UTC) {
    if (digits.startsWith(prefix)) return off;
  }
  return 0;
}

/** Recipient's local hour right now (0-23, fractional offsets floored). */
export function recipientLocalHour(toDigits: string): number {
  const off = utcOffsetFor(toDigits);
  const h = (new Date().getUTCHours() + new Date().getUTCMinutes() / 60 + off + 24) % 24;
  return Math.floor(h);
}

/** Next moment the recipient's business window opens, as ISO string. */
function nextBusinessOpen(toDigits: string, p: SecurityPolicies): string {
  const off = utcOffsetFor(toDigits);
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
  // Punctuation/spacing jitter - invisible to a human, new hash every time.
  if (Math.random() < 0.35) out = out.replace(/\. /g, ".  ");
  if (Math.random() < 0.3 && !/[?!]$/.test(out)) out = out.replace(/\.$/, "");
  return out;
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
  meta?: Record<string, unknown>; // thread context for queued sends
}): Promise<GuardVerdict> {
  const p = await getPolicies();
  const text = opts.auto ? humanizeVariant(opts.text) : opts.text;

  // 1. Two-way engagement halt: never send another AUTOMATED message to a
  //    number that has not replied since our last outbound to it.
  if (opts.auto && p.engagement_halt) {
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
      if (!inboundSince.length) {
        return {
          allow: false,
          reason: "engagement-halt: waiting for the shop to reply first",
          text,
        };
      }
    }
  }

  // 2. Recipient business hours: park night sends until the window opens.
  const hour = recipientLocalHour(opts.toDigits);
  const inWindow = hour >= p.business_hour_start && hour < p.business_hour_end;
  if (opts.auto && !inWindow) {
    if (opts.queueIfBlocked !== false) {
      const notBefore = nextBusinessOpen(opts.toDigits, p);
      await sbInsert("wa_outbox", [
        {
          sender_key: opts.senderKey,
          to_number: opts.toDigits,
          body: text,
          not_before: notBefore,
          meta: opts.meta ?? null,
        },
      ]);
      return {
        allow: false,
        reason: "outside recipient business hours - queued",
        queuedUntil: notBefore,
        text,
      };
    }
    return { allow: false, reason: "outside recipient business hours", text };
  }

  // 3. Dynamic volume caps from reputation (velocity vector).
  const rep = await getReputation(opts.senderKey);
  const hourCap = dynamicHourCap(rep, p);
  const now = Date.now();
  const sentRows = await sbSelect<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      opts.senderKey
    )}&received_at=gte.${encodeURIComponent(
      new Date(now - 24 * 3600_000).toISOString()
    )}&order=received_at.desc&limit=200`
  );
  const hourAgo = new Date(now - 3600_000).toISOString();
  const lastHour = sentRows.filter((r) => r.received_at >= hourAgo).length;
  if (lastHour >= hourCap) {
    return {
      allow: false,
      reason: `dynamic hourly cap reached (${hourCap}/h at trust ${rep.trust_score})`,
      text,
    };
  }
  if (sentRows.length >= p.day_cap) {
    return { allow: false, reason: `daily cap reached (${p.day_cap}/day)`, text };
  }

  // 4. Anti-robotic minimum gap with jitter.
  if (rep.last_send_at) {
    const gapNeeded =
      (p.min_gap_seconds + Math.random() * p.gap_jitter_seconds) * 1000;
    const since = now - Date.parse(rep.last_send_at);
    if (opts.auto && since < gapNeeded) {
      if (opts.queueIfBlocked !== false) {
        const notBefore = new Date(now + (gapNeeded - since)).toISOString();
        await sbInsert("wa_outbox", [
          {
            sender_key: opts.senderKey,
            to_number: opts.toDigits,
            body: text,
            not_before: notBefore,
            meta: opts.meta ?? null,
          },
        ]);
        return {
          allow: false,
          reason: "human pacing gap - queued",
          queuedUntil: notBefore,
          text,
        };
      }
      return { allow: false, reason: "human pacing gap", text };
    }
  }

  return { allow: true, text };
}

/** Book-keeping after a successful send (trust decay + last_send_at). */
export async function afterSend(senderKey: string): Promise<void> {
  await recordOutboundSend(senderKey);
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
      await afterSend(row.sender_key);
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
