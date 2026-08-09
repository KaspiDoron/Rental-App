import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getPolicies, setPolicy, deletePolicy, clearPause, computeRisk } from "@/lib/wa-guard";
import { validatePolicyWrite, POLICY_SPEC } from "@/lib/wa/policy-values";
import { sbSelect } from "@/lib/runtime-config";

// Owner control panel for the Anti-Ban engine: current effective policies
// (DB overrides merged over code defaults) with a plain-language explanation +
// best-practice hint for EVERY knob, per-number trust/risk scores, and the
// queued outbox. POST updates a knob or lifts a pause - applied live.

// Explanation + best-practice for each policy knob (shown in an info popup).
const POLICY_HELP: Record<string, { label: string; help: string; best: string }> = {
  base_hour_cap: {
    label: "Base messages / hour",
    help: "Messages per hour allowed for a number at trust score 0 (a brand-new, unproven number).",
    best: "Keep low (3-5). New numbers should barely send until they earn trust from real replies.",
  },
  max_hour_cap: {
    label: "Max messages / hour",
    help: "The ceiling a fully-trusted number (score 100) can send per hour.",
    best: "12-18 is safe for personal numbers. Higher looks like a call-center and raises risk.",
  },
  day_cap: {
    label: "Daily hard cap",
    help: "Absolute messages per number per day, whatever the trust score.",
    best: "30-50/day for a personal number. WhatsApp flags sustained high daily volume.",
  },
  min_gap_seconds: {
    label: "Min gap between sends (s)",
    help: "Minimum seconds between two messages from the same number.",
    best: "40-60s. Humans never fire messages back-to-back; instant sends are a bot signal.",
  },
  gap_jitter_seconds: {
    label: "Gap random jitter (s)",
    help: "Random extra delay added on top of the minimum gap, so spacing is never robotic.",
    best: "60-90s. Randomness in timing is itself a strong anti-detection measure.",
  },
  warmup_days: {
    label: "Warm-up period (days)",
    help: "How many days a newly linked number ramps up from a tiny budget to its full budget.",
    best: "7 days. The research shows fresh numbers doing volume on day 1 is the top ban trigger.",
  },
  business_hour_start: {
    label: "Business hours start",
    help: "Earliest local hour (recipient's timezone) an automated message may be sent.",
    best: "9. Never message shops before they open - night sends scream automation.",
  },
  business_hour_end: {
    label: "Business hours end",
    help: "Latest local hour (recipient's timezone) an automated message may be sent.",
    best: "20. After this, messages are queued to the next morning automatically.",
  },
  trust_reply_gain: {
    label: "Trust gained per reply",
    help: "Points added to a number's trust score each time a shop replies (two-way engagement).",
    best: "5-8. Replies are proof of legitimate conversation; reward them so limits relax naturally.",
  },
  trust_send_decay: {
    label: "Trust lost per send",
    help: "Points removed per outbound message, so pure one-way blasting slowly tightens limits.",
    best: "1. Small, so a healthy back-and-forth stays net-positive on trust.",
  },
  engagement_halt: {
    label: "Engagement halt (on/off)",
    help: "If on, no second automated message goes to a shop until it replies OR reads (blue tick).",
    best: "true. This single rule prevents the #1 spam pattern: chasing people who ignore you.",
  },
  presence_min_ms: {
    label: "Typing sim - min (ms)",
    help: "Shortest 'composing…' (typing) indicator shown before a message is sent.",
    best: "2500. Real people type before sending; instant sends with no typing look automated.",
  },
  presence_max_ms: {
    label: "Typing sim - max (ms)",
    help: "Longest typing indicator, scaled by message length.",
    best: "8000. Longer messages should show longer typing - keep it proportional.",
  },
  idle_pause_hours: {
    label: "Idle quiet-down (hours)",
    help: "Hours without app use before the number's presence goes offline (stops looking 'always online').",
    best: "6. Keeps the linked device from appearing active 24/7 - a comfort + anti-flag win.",
  },
  max_new_contacts_per_day: {
    label: "New shops / day (cold cap)",
    help: "How many brand-new shops a number may first-contact in a day. THE most important limit.",
    best: "10-15. Many first-time chats to strangers who never reply is the strongest ban signal.",
  },
  min_reply_rate: {
    label: "Min reply rate (breaker)",
    help: "If the fraction of shops that reply drops below this (with enough history), cold outreach freezes.",
    best: "0.15 (15%). Below this, WhatsApp reads the number as a spammer - freezing protects it.",
  },
  min_reply_samples: {
    label: "Reply-rate sample size",
    help: "How many sends must happen before the reply-rate breaker is allowed to act.",
    best: "8. Enough data to be meaningful without over-reacting to the first few chats.",
  },
  risk_pause_threshold: {
    label: "Auto-pause risk score",
    help: "Ban-risk score (0-100) at which a number is automatically paused and you are alerted.",
    best: "70. High enough to avoid false alarms, low enough to act before a real restriction.",
  },
  risk_pause_minutes: {
    label: "Auto-pause length (min)",
    help: "How long an auto-pause lasts before sending is allowed to resume (graduated recovery).",
    best: "240 (4h). After a real block the research recommends 24-48h - raise this if a number was restricted.",
  },
  burst_window_seconds: {
    label: "Burst window (s)",
    help: "Rolling window used to detect a burst of sends.",
    best: "600 (10 min). Sends clustered in a short window look robotic even under the hourly cap.",
  },
  burst_max_in_window: {
    label: "Max sends per burst window",
    help: "How many sends are allowed inside the burst window before an enforced rest.",
    best: "5. Keeps output spread out across the hour instead of bunched.",
  },
  burst_cooldown_minutes: {
    label: "Post-burst cooldown (min)",
    help: "Enforced rest after a burst is detected, before the next send.",
    best: "30. A natural human pause after a flurry of messages.",
  },
  require_number_on_whatsapp: {
    label: "Validate number on WhatsApp",
    help: "Skip/flag sends to numbers not registered on WhatsApp (failed sends look like list-blasting).",
    best: "true. Sending to invalid numbers is a classic spammer footprint.",
  },
  daily_cap_jitter_pct: {
    label: "Daily cap random wobble (%)",
    help: "Randomly varies each number's daily/hourly cap by ± this percent, per day.",
    best: "20. A perfectly fixed cap is itself a detectable pattern; a little wobble hides it.",
  },
  reply_gap_seconds: {
    label: "Reply lane min gap (s)",
    help: "Minimum seconds between two REPLIES to already-engaged shops (a faster lane than cold intros).",
    best: "5. Two-way conversations are low ban-risk; keeping replies responsive is what feels human.",
  },
  ignore_business_hours: {
    label: "Ignore business hours (on/off)",
    help: "If on, cold intros are NOT held for the shop's local clock window. Normally derived from Pacing Mode / Fast dispatch - a row here overrides both.",
    best: "Leave unset. Set only to force a permanent 24/7 or clock-gated behavior regardless of the dials.",
  },
  fast_dispatch: {
    label: "Fast dispatch (on/off)",
    help: "If on, a new batch fires within its 15-minute window regardless of shop opening hours (messages simply wait unread). Normally derived from the FAST_DISPATCH key - a row here overrides it.",
    best: "Leave unset (defaults on). Turning it off holds evening batches until shops open.",
  },
};

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [policies, reputation, outbox] = await Promise.all([
    getPolicies(),
    sbSelect<Record<string, unknown>>(
      "whatsapp_number_reputation",
      "select=sender_key,trust_score,risk_score,sent_total,replies_total,blocks_total,fails_total,reads_total,delivered_total,new_contacts_today,paused_until,last_send_at,last_reply_at,created_at&order=risk_score.desc&limit=100"
    ),
    sbSelect(
      "wa_outbox",
      "select=id,sender_key,to_number,not_before,created_at&order=not_before.asc&limit=50"
    ),
  ]);

  // Attach a live risk breakdown per number so the owner sees WHY a score is high.
  const reputationWithRisk = reputation.map((r) => ({
    ...r,
    risk: computeRisk(r as never, policies),
  }));

  return NextResponse.json({
    policies,
    help: POLICY_HELP,
    reputation: reputationWithRisk,
    outbox,
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // Lift an auto-pause on a number.
  if (body.action === "clear-pause" && body.senderKey) {
    await clearPause(String(body.senderKey));
    return NextResponse.json({ ok: true });
  }

  // Remove an override row so the code default applies again. setPolicy is
  // upsert-only, so without this a bad row was permanent from the UI.
  if (body.action === "reset" && body.key) {
    const key = String(body.key).trim();
    if (!(key in POLICY_SPEC)) {
      return NextResponse.json({ error: `Unknown policy "${key}".` }, { status: 400 });
    }
    await deletePolicy(key);
    return NextResponse.json({ ok: true, policies: await getPolicies() });
  }

  const key = String(body.key ?? "").trim();
  const value = String(body.value ?? "").trim();
  if (!key || !value) {
    return NextResponse.json({ error: "key and value required" }, { status: 400 });
  }
  // The value contract gates every write: unknown keys and out-of-range or
  // wrong-dialect values are rejected with a reason the panel shows, and
  // flags are stored in the canonical "true"/"false" spelling. Before this,
  // any string was stored verbatim and the read side quietly inverted or
  // ignored it - the owner's dial and the engine's behavior disagreed with
  // no trace.
  const verdict = validatePolicyWrite(key, value);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: 400 });
  }
  // Guard the hours window as a pair: a write that would invert it is refused.
  if (key === "business_hour_start" || key === "business_hour_end") {
    const current = await getPolicies();
    const start = key === "business_hour_start" ? Number(verdict.normalized) : current.business_hour_start;
    const end = key === "business_hour_end" ? Number(verdict.normalized) : current.business_hour_end;
    if (start >= end) {
      return NextResponse.json(
        { error: `Business hours must satisfy start < end (got ${start} >= ${end}).` },
        { status: 400 }
      );
    }
  }
  // THE AUTHOR TRAVELS WITH THE CHANGE. An anti-ban knob whose worst case is a
  // traveller losing their WhatsApp had, until now, less audit trail than the
  // negotiation policy next door - whose worst case is a bad haggle. The email
  // comes from the SERVER session, never from the body: a client naming its own
  // author would make the one field the record exists to establish untrusted.
  await setPolicy(key, verdict.normalized, session.email, typeof body.note === "string" ? body.note : undefined);
  return NextResponse.json({ ok: true, policies: await getPolicies() });
}
