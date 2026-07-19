import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { senderSafety, type SenderSafety } from "@/lib/wa-guard";

// The living-workspace feed: one endpoint that tells the user everything
// their agents are doing, chronologically, across every shop - built ENTIRELY
// from data the engine already persists on the live path (agent_traces,
// whatsapp_messages, vendor_replies, offers, wa_outbox, graph_wakeups,
// agent_scores, agent_events). Strictly scoped to the signed-in user.
//
// Also serves:
//   ?why=<decisionId>  -> the persisted director ladder for that decision
//   queue              -> same shape as /api/queue (this poll REPLACES it)
//   waHealth           -> the anti-ban guard's honest safety state

export interface ActivityItem {
  id: string;
  at: string; // ISO
  kind: "trace" | "sent" | "reply" | "offer" | "queued" | "wait" | "judge" | "alert";
  vendorId?: string;
  vendorName?: string;
  title: string;
  detail?: string;
  decisionId?: string;
  meta?: Record<string, unknown>;
}

// Friendly titles for pipeline stages a traveller should actually see.
// Anything not listed here is engine plumbing and stays out of the feed.
const STAGE_TITLES: Record<string, string> = {
  transcribe: "Listened to the shop's voice note",
  extract: "Read the shop's reply",
  "media-coherence": "Double-checked the photo against the conversation",
  "media-gap": "Checked what the deal is still missing",
  director: "Chose the next move",
  bargain: "Bargained for a better price",
  clarify: "Asked the shop to clarify",
  answer: "Answered the shop's question",
  "deposit-probe": "Asked about the deposit",
  "fulfillment-probe": "Asked how you get the vehicle",
  "pickup-location": "Shared your pickup location (with your consent)",
  close: "Wrapped up the conversation",
  present: "Marked this offer ready for you",
  "closing-message": "Sent the closing message",
  deliver: "Message on its way to the shop",
};

interface TraceRow {
  id: number;
  decision_id: string;
  vendor_id: string | null;
  vendor_name: string | null;
  stage: string;
  reasoning: string | null;
  output: string | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const email = session.email;
  const enc = encodeURIComponent(email);
  const url = new URL(req.url);

  // ---- "Why this move?" lookup (ownership-verified) -------------------------
  const why = url.searchParams.get("why");
  if (why) {
    const rows = await sbSelect<TraceRow & { user_email: string | null }>(
      "agent_traces",
      `select=id,decision_id,user_email,vendor_id,vendor_name,stage,reasoning,output,created_at&decision_id=eq.${encodeURIComponent(
        why
      )}&stage=eq.ladder&limit=1`
    ).catch(() => []);
    const row = rows[0];
    // STRICT ownership: a trace with NO owner stamp is nobody's to read -
    // the old `row.user_email && ...` guard returned it to ANY signed-in
    // caller who knew the id. Reject unless the stamp matches exactly.
    if (!row || row.user_email !== email) {
      return NextResponse.json({ ladder: null });
    }
    let ladder: unknown = null;
    try {
      ladder = JSON.parse(row.output ?? "null");
    } catch {}
    return NextResponse.json({ ladder, at: row.created_at, vendorName: row.vendor_name });
  }

  // Opportunistic drain: this endpoint is polled while the app is open, so it
  // inherits the queue-poll's job of actually sending due messages.
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    // Tagged failures: a broken drain must show up in the Vercel logs, not
    // vanish into a blanket catch (it silently stops all queued sends).
    void drainOutbox((k, to, text) => sendFromUser(k, to, text)).catch((e) =>
      console.error("[drain:outbox]", e instanceof Error ? e.message : e)
    );
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    void drainGraphWakeups((k, to, text) => sendFromUser(k, to, text)).catch((e) =>
      console.error("[drain:wakeups]", e instanceof Error ? e.message : e)
    );
  } catch (e) {
    console.error("[drain:init]", e instanceof Error ? e.message : e);
  }

  const sinceMs = Number(url.searchParams.get("since")) || Date.now() - 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 10), 80);

  const [traces, outbound, replies, offers, outbox, wakeups, events] = await Promise.all([
    sbSelect<TraceRow>(
      "agent_traces",
      `select=id,decision_id,vendor_id,vendor_name,stage,reasoning,output,created_at&user_email=eq.${enc}&created_at=gte.${sinceIso}&order=created_at.desc&limit=120`
    ).catch(() => [] as TraceRow[]),
    sbSelect<{
      id: number;
      to_number: string;
      body: string;
      raw: { vendorId?: string; vendorName?: string; english?: string; kind?: string } | null;
      received_at: string;
    }>(
      "whatsapp_messages",
      // Marker rows (session pause/takeover flags) live in the same table -
      // keep them out of the human-facing feed. Fetched deep enough (150) that
      // the per-vendor state rollup below covers a full 40+ shop batch, not just
      // the newest 40 (the feed itself is still sliced to `limit`).
      `select=id,to_number,body,raw,received_at&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${sinceIso}&order=received_at.desc&limit=150`
    ).catch(() => []),
    sbSelect<{
      id: number;
      vendor_id: string | null;
      vendor_name: string | null;
      reply_text: string | null;
      image_count: number | null;
      created_at: string;
    }>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,image_count,created_at&user_email=eq.${enc}&created_at=gte.${sinceIso}&order=created_at.desc&limit=80`
    ).catch(() => []),
    sbSelect<{
      id: number;
      vendor_id: string | null;
      vendor_name: string | null;
      price_per_day: number | null;
      currency: string | null;
      round: number | null;
      verified: boolean | null;
      created_at: string;
    }>(
      "offers",
      `select=id,vendor_id,vendor_name,price_per_day,currency,round,verified,created_at&user_email=eq.${enc}&simulated=eq.false&created_at=gte.${sinceIso}&order=created_at.desc&limit=80`
    ).catch(() => []),
    sbSelect<{
      id: number;
      to_number: string;
      not_before: string;
      meta: { reason?: string; vendorName?: string; vendorId?: string } | null;
    }>(
      "wa_outbox",
      `select=id,to_number,not_before,meta&sender_key=eq.${enc}&order=not_before.asc&limit=50`
    ).catch(() => []),
    sbSelect<{
      id: number;
      kind: string;
      thread_key: string;
      not_before: string;
      payload: { reason?: string; vendorName?: string } | null;
      created_at: string;
    }>(
      "graph_wakeups",
      // EXACT ownership match on the stamped column - the old
      // `thread_key=like.<email>:*` read could surface a DIFFERENT user's
      // wakeup when one email `_`-wildcard-matched another. Same fix + same
      // legacy-row tradeoff as the agent_events filter below.
      `select=id,kind,thread_key,not_before,payload,created_at&user_email=eq.${encodeURIComponent(
        email
      )}&kind=eq.tick&order=not_before.asc&limit=10`
    ).catch(() => []),
    sbSelect<{
      id: number;
      kind: string;
      vendor_id: string | null;
      vendor_name: string | null;
      detail: string | null;
      created_at: string;
    }>(
      "agent_events",
      // EXACT ownership match - the old detail LIKE *email* substring filter
      // showed n@x.com the risk alerts (incl. message excerpts) of john@x.com.
      // Unstamped legacy rows are hidden by design; the feed is time-windowed
      // so they age out within a day.
      `select=id,kind,vendor_id,vendor_name,detail,created_at&kind=eq.inbound-risk&user_email=eq.${encodeURIComponent(
        email
      )}&created_at=gte.${sinceIso}&order=created_at.desc&limit=10`
    ).catch(() => []),
  ]);

  // decisionId per vendor (newest first) so cards can open "Why this move?".
  const ladderByDecision = new Set(
    traces.filter((t) => t.stage === "ladder").map((t) => t.decision_id)
  );
  const whyByVendor: Record<string, string> = {};
  for (const t of traces) {
    if (t.stage === "ladder" && t.vendor_id && !whyByVendor[t.vendor_id]) {
      whyByVendor[t.vendor_id] = t.decision_id;
    }
  }

  // ---- PER-VENDOR CONVERSATION STATE (the authoritative card signal) --------
  // The Live Status panel counted delivered RFQs from a 200-row server
  // aggregate while each CARD reconstructed its stage from a truncated feed -
  // split-brain, so a shop the panel counted "started" stayed stuck in the
  // "queued message" visual. This rollup is the card's authoritative signal:
  // built from the source rows above (fetched deep enough - 150 outbound / 80
  // replies+offers / 120 traces - to cover a full 40+ shop batch), keyed by
  // vendorId, so the card status mirrors the real DB state regardless of soft
  // filters. Ranked messaged < active < offer.
  const STATE_RANK = { messaged: 1, active: 2, offer: 3 } as const;
  type VState = keyof typeof STATE_RANK;
  const vendorStates: Record<string, VState> = {};
  const bumpState = (id: string | null | undefined, s: VState) => {
    if (!id) return;
    const cur = vendorStates[id];
    if (!cur || STATE_RANK[s] > STATE_RANK[cur]) vendorStates[id] = s;
  };
  // We MESSAGED the shop (RFQ delivered).
  for (const m of outbound) if (m.raw?.kind === "rfq") bumpState(m.raw?.vendorId, "messaged");
  // The agent is ACTIVELY working the thread (any engine trace) or the shop
  // has REPLIED - either way it is a live conversation, not a queued message.
  for (const t of traces) if (STAGE_TITLES[t.stage]) bumpState(t.vendor_id, "active");
  for (const r of replies) bumpState(r.vendor_id, "active");
  // A real priced OFFER is the strongest state.
  for (const o of offers) if (o.price_per_day) bumpState(o.vendor_id, "offer");

  const items: ActivityItem[] = [];

  for (const t of traces) {
    const title = STAGE_TITLES[t.stage];
    if (!title) continue; // plumbing stages stay out of the feed
    items.push({
      id: `trace:${t.id}`,
      at: t.created_at,
      kind: "trace",
      vendorId: t.vendor_id ?? undefined,
      vendorName: t.vendor_name ?? undefined,
      title,
      detail: (t.reasoning ?? "").slice(0, 220) || undefined,
      decisionId: ladderByDecision.has(t.decision_id) ? t.decision_id : undefined,
    });
  }
  for (const m of outbound) {
    const human = m.raw?.kind === "human-manual";
    items.push({
      id: `sent:${m.id}`,
      at: m.received_at,
      kind: "sent",
      vendorId: m.raw?.vendorId,
      vendorName: m.raw?.vendorName,
      title: human ? "You messaged the shop yourself" : "Message sent to the shop",
      detail: (m.raw?.english || m.body || "").slice(0, 220) || undefined,
    });
  }
  for (const r of replies) {
    items.push({
      id: `reply:${r.id}`,
      at: r.created_at,
      kind: "reply",
      vendorId: r.vendor_id ?? undefined,
      vendorName: r.vendor_name ?? undefined,
      title: r.image_count ? "The shop replied (with a photo)" : "The shop replied",
      detail: (r.reply_text ?? "").slice(0, 220) || undefined,
    });
  }
  for (const o of offers) {
    if (!o.price_per_day) continue;
    items.push({
      id: `offer:${o.id}`,
      at: o.created_at,
      kind: "offer",
      vendorId: o.vendor_id ?? undefined,
      vendorName: o.vendor_name ?? undefined,
      title: o.verified ? "Confirmed offer in" : "Offer in (unconfirmed)",
      detail: undefined,
      meta: {
        pricePerDay: o.price_per_day,
        currency: o.currency ?? "USD",
        round: o.round ?? 0,
        verified: Boolean(o.verified),
      },
    });
  }
  const now = Date.now();
  for (const w of wakeups) {
    if (Date.parse(w.not_before) <= now) continue;
    items.push({
      id: `wait:${w.id}`,
      at: w.created_at,
      kind: "wait",
      vendorName: w.payload?.vendorName,
      title: "Will is waiting on purpose",
      detail:
        (w.payload?.reason ??
          "waiting a moment so the shop takes the offer seriously") +
        ` (until ${new Date(w.not_before).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`,
    });
  }
  for (const e of events) {
    let excerpt = "";
    let risk = "high";
    let reasons: string[] = [];
    try {
      const d = JSON.parse(e.detail ?? "{}");
      excerpt = String(d.excerpt ?? "");
      risk = String(d.risk ?? "high");
      if (Array.isArray(d.reasons)) reasons = d.reasons.map(String);
    } catch {}
    items.push({
      id: `alert:${e.id}`,
      at: e.created_at,
      kind: "alert",
      vendorId: e.vendor_id ?? undefined,
      vendorName: e.vendor_name ?? undefined,
      title: "Will flagged this reply - please review",
      detail: (reasons[0] ?? excerpt).slice(0, 220) || undefined,
      meta: { risk, excerpt: excerpt.slice(0, 200) },
    });
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  // Same shape as /api/queue so the existing queue card keeps working. The
  // reason is the guard's REAL stored reason translated honestly - a pacing
  // hold must never masquerade as "shop closed".
  const { queueReasonLabel } = await import("@/lib/queue-reason");
  const queue = outbox.map((r) => {
    const at = Date.parse(r.not_before);
    const meta = r.meta as { vendorId?: string; vendorName?: string; reason?: string; kind?: string } | null;
    return {
      id: r.id,
      vendorId: meta?.vendorId ?? null,
      vendorName: meta?.vendorName ?? null,
      toNumber: r.to_number,
      notBefore: r.not_before,
      due: at <= now,
      kind: meta?.kind ?? null,
      reason: at <= now ? "Sending shortly" : queueReasonLabel(meta?.reason),
      rawReason: meta?.reason ?? null,
    };
  });

  let waHealth: SenderSafety | null = null;
  try {
    waHealth = await senderSafety(email);
  } catch {}

  // The plan's rolling introductions budget, so the queued panel can show a
  // STANDING "X of N new shops this window - next opens ~HH:MM" indicator
  // instead of the limit only flashing once as a mass-bargain toast.
  let introBudget: {
    remaining: number;
    cap: number;
    windowHours: number;
    nextFreeAt: string;
  } | null = null;
  try {
    const { newContactBudget } = await import("@/lib/wa-guard");
    introBudget = await newContactBudget(email, session.plan);
  } catch {}

  // Numbers the user explicitly cancelled (removed queued messages) - the UI
  // shows those shops as "paused by you" instead of pretending nothing
  // happened, and the resume CTA is the explicit action that clears it.
  let cancelled: string[] = [];
  try {
    const { cancelledNumbers } = await import("@/lib/wa/cancellations");
    cancelled = await cancelledNumbers(email);
  } catch {}

  return NextResponse.json({
    items: items.slice(0, limit),
    queue,
    waHealth,
    introBudget,
    whyByVendor,
    vendorStates,
    cancelledNumbers: cancelled,
    now: new Date().toISOString(),
  });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
