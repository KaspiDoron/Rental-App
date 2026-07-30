import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { senderSafety, type SenderSafety } from "@/lib/wa-guard";
import { deriveCountered } from "@/lib/counter-offer";

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

/**
 * How to phrase a pending wait. Minutes for anything short (the only kind a
 * negotiation tactic ever is), a clock time only once it is genuinely far off.
 */
function waitEta(notBefore: string, nowMs: number): string {
  const at = Date.parse(notBefore);
  if (!Number.isFinite(at)) return "in a moment";
  const mins = Math.round((at - nowMs) / 60_000);
  if (mins <= 1) return "about a minute";
  if (mins < 60) return `about ${mins} min`;
  return `until ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
    // Tagged failures: a broken drain must show up in the server logs, not
    // vanish into a blanket catch (it silently stops all queued sends).
    // AWAITED, not fire-and-forget. On Cloud Run the CPU is throttled to ~0
    // once the response is flushed, so a `void` drain was suspended mid-send:
    // messages the UI had already moved past stayed in the outbox forever.
    // Bounded so a slow host can never hold the poll open.
    const DRAIN_BUDGET_MS = 8_000;
    const bounded = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await bounded(
      drainOutbox((k, to, text) => sendFromUser(k, to, text)).catch((e) =>
        console.error("[drain:outbox]", e instanceof Error ? e.message : e)
      )
    );
    await bounded(
      drainGraphWakeups((k, to, text) => sendFromUser(k, to, text)).catch((e) =>
        console.error("[drain:wakeups]", e instanceof Error ? e.message : e)
      )
    );
  } catch (e) {
    console.error("[drain:init]", e instanceof Error ? e.message : e);
  }

  const sinceMs = Number(url.searchParams.get("since")) || Date.now() - 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 40, 10), 80);

  const [traces, outbound, replies, offers, outbox, wakeups, events, inboundRows] = await Promise.all([
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
      //
      // DROPS ARE FEED EVENTS TOO. The engine records inbound-dropped and
      // send-dropped honestly, but the feed used to read inbound-risk ONLY -
      // so a message the guard refused or a reply the pipeline lost had a
      // durable trace no user surface ever showed. Benign drops (privacy
      // gate, user pause, coalesced turns) are filtered out downstream.
      `select=id,kind,vendor_id,vendor_name,detail,created_at&kind=in.("inbound-risk","inbound-dropped","send-dropped")&user_email=eq.${encodeURIComponent(
        email
      )}&created_at=gte.${sinceIso}&order=created_at.desc&limit=20`
    ).catch(() => []),
    sbSelect<{ from_number: string; body: string | null; received_at: string }>(
      "whatsapp_messages",
      // STORED inbound, straight from the wire. vendor_replies only exists once
      // the agent turn DERIVED the message - so a stored reply whose turn
      // failed (or is still queued for the recovery sweep) left the card on
      // "Awaiting reply" while the reply sat in the DB. The card state must
      // follow the wire, not the derivation.
      `select=from_number,body,received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&received_at=gte.${sinceIso}&order=received_at.desc&limit=60`
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
  // A reply STORED but not yet derived counts too: join the raw inbound rows to
  // vendors by number via our own outbound rows. "Awaiting reply" can never
  // coexist with a reply already sitting in whatsapp_messages.
  const { digitsOnly } = await import("@/lib/phone");
  const vendorByDigits: Record<string, string> = {};
  for (const m of outbound) {
    const id = m.raw?.vendorId;
    const digits = digitsOnly(m.to_number);
    if (id && digits && !vendorByDigits[digits]) vendorByDigits[digits] = id;
  }
  for (const m of inboundRows) bumpState(vendorByDigits[digitsOnly(m.from_number)], "active");
  // A real priced OFFER is the strongest state.
  for (const o of offers) if (o.price_per_day) bumpState(o.vendor_id, "offer");

  // ---- COUNTER-OFFER DETECTION (derived, never cosmetic) --------------------
  // See deriveCountered(): a vendor is countered once the agent has sent a
  // bargain move after the shop's opening quote (offer round>=1, or an outbound
  // bargain timestamped after the first inbound). Emitted as a SEPARATE signal
  // (not folded into the messaged<active<offer rank) so it never blocks the
  // priced offer from surfacing - the client only relabels the STAGE.
  const countered = deriveCountered({ offers, replies, outbound });

  // ---- PER-VENDOR LAST MESSAGES (F4 batch status) --------------------------
  // The status screen wants {shop, last shop message, last agent message} for
  // EVERY shop in one response. Previously the client N+1-polled /api/thread per
  // card; here we derive it from the outbound + replies rows already fetched.
  // Rows are newest-first, so the FIRST per vendor is the latest.
  type LastMsg = {
    lastOutboundText?: string;
    lastOutboundAt?: string;
    lastInboundText?: string;
    lastInboundAt?: string;
  };
  const lastByVendor: Record<string, LastMsg> = {};
  const ensureLast = (id: string): LastMsg => (lastByVendor[id] ??= {});
  for (const m of outbound) {
    const id = m.raw?.vendorId;
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastOutboundAt) continue; // already have the newest for this vendor
    // Prefer the English gloss for the panel; fall back to the raw sent body.
    slot.lastOutboundText = (m.raw?.english || m.body || "").slice(0, 240);
    slot.lastOutboundAt = m.received_at;
  }
  for (const r of replies) {
    const id = r.vendor_id;
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastInboundAt) continue;
    slot.lastInboundText = (r.reply_text || (r.image_count ? "[photo]" : "") || "").slice(0, 240);
    slot.lastInboundAt = r.created_at;
  }
  // Underived-but-stored inbound fills the gap (newest-first here too), so the
  // panel shows what the shop actually said even before the agent turn runs.
  for (const m of inboundRows) {
    const id = vendorByDigits[digitsOnly(m.from_number)];
    if (!id) continue;
    const slot = ensureLast(id);
    if (slot.lastInboundAt && Date.parse(slot.lastInboundAt) >= Date.parse(m.received_at)) continue;
    slot.lastInboundText = (m.body || "").slice(0, 240) || slot.lastInboundText;
    slot.lastInboundAt = m.received_at;
  }

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
      // A deliberate pause is minutes, so say MINUTES. The old absolute clock
      // time turned a two-minute pause into "until 08:28 AM" - which read as
      // "the agents are asleep until tomorrow" on a thread that had just
      // replied. A clock time is only meaningful when the wait is genuinely
      // long, and by then it is a queue hold, not a tactic.
      detail:
        (w.payload?.reason ?? "waiting a moment so the shop takes the offer seriously") +
        ` (${waitEta(w.not_before, now)})`,
    });
  }
  const { dropFeedItem } = await import("@/lib/wa/safety-signals");
  for (const e of events) {
    if (e.kind === "inbound-dropped" || e.kind === "send-dropped") {
      const drop = dropFeedItem(e.kind, e.detail);
      if (!drop) continue; // benign, deliberate outcome - not an alert
      items.push({
        id: `alert:${e.id}`,
        at: e.created_at,
        kind: "alert",
        vendorId: e.vendor_id || undefined,
        // vendor_name on drop events carries the shop's digits, not a name -
        // the feed shows the honest copy, not a phone number masquerading.
        title: drop.title,
        detail: drop.detail,
        meta: { risk: "info" },
      });
      continue;
    }
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
  //
  // STATUS-PANEL DEDUP (live-trial fix): "Your queued messages" is the list of
  // UN-SENT INTROS. A parked agent REPLY to an already-messaged shop (kind
  // reply / bargain / auto-*) must NOT appear here - it made the same shop show
  // in "Messaged"/"Offers" AND "Queued" simultaneously. Replies surface through
  // the conversation thread, not the intro queue.
  const { queueReasonLabel } = await import("@/lib/queue-reason");
  const { cleanShopName } = await import("@/lib/text");
  const { outboxState } = await import("@/lib/wa/outbox-lifecycle");
  // Tombstones WITH their actor, fetched before the queue is shaped: a
  // tombstoned shop's rows are terminally dropped at drain, so advertising
  // them here ("next at ~05:38" over removed shops) was a promise the drain
  // was about to break. They are excluded from the queue payload, the ETA
  // simulation and the progress counters alike.
  let cancelledShops: { digits: string; reason: string; at: string | null }[] = [];
  try {
    const { cancelledEntries } = await import("@/lib/wa/cancellations");
    cancelledShops = await cancelledEntries(email);
  } catch {}
  const cancelledSet = new Set(cancelledShops.map((c) => c.digits));
  const INTRO_KINDS = new Set(["rfq", "custom", "human-manual"]);
  const queue = outbox
    .filter((r) => {
      const kind = (r.meta as { kind?: string } | null)?.kind;
      return (!kind || INTRO_KINDS.has(kind)) && !cancelledSet.has(r.to_number);
    })
    .map((r) => {
      const meta = r.meta as { vendorId?: string; vendorName?: string; reason?: string; kind?: string } | null;
      // Same lifecycle definition the queue viewer uses - the two surfaces can
      // no longer disagree about a message that is going out right now.
      const state = outboxState(r.not_before, meta, now);
      const sending = state === "sending";
      return {
        id: r.id,
        vendorId: meta?.vendorId ?? null,
        vendorName: meta?.vendorName ? cleanShopName(meta.vendorName) : null,
        toNumber: r.to_number,
        notBefore: r.not_before,
        due: state !== "waiting",
        sending,
        kind: meta?.kind ?? null,
        reason: sending
          ? "Sending now"
          : state === "due"
            ? "Sending shortly"
            : queueReasonLabel(meta?.reason),
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

  // HONEST ETA (W2): the queue rows above carry not_before (a LOWER bound). Turn
  // it into a realistic [etaFrom, etaTo] window by simulating the drain's min-gap
  // + cold budget + drain cadence over queue position, so the UI can show a
  // "~10:20-10:25" range instead of a point estimate that silently slips.
  let queueEtaDoneBy: string | null = null;
  try {
    const { getPolicies } = await import("@/lib/wa-guard");
    const { computeQueueEtas } = await import("@/lib/wa/eta");
    const policies = await getPolicies();
    const lastOut = await sbSelect<{ received_at: string }>(
      "whatsapp_messages",
      `select=received_at&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=1`
    ).catch(() => []);
    const stealth =
      waHealth?.state === "paused" ? 2.5 : waHealth?.state === "pacing" ? 1.5 : 1;
    const etas = computeQueueEtas(
      queue.map((q) => ({
        id: q.id,
        notBeforeMs: Date.parse(q.notBefore),
        kind: q.kind,
        rawReason: q.rawReason,
      })),
      {
        nowMs: now,
        lastSendAtMs: lastOut[0]?.received_at ? Date.parse(lastOut[0].received_at) : null,
        minGapSec: policies.min_gap_seconds,
        gapJitterSec: policies.gap_jitter_seconds,
        stealth,
        introRemaining: introBudget?.remaining ?? 0,
        introNextFreeAtMs: introBudget?.nextFreeAt ? Date.parse(introBudget.nextFreeAt) : null,
      }
    );
    let maxTo = 0;
    for (const q of queue as (typeof queue[number] & { etaFrom?: string; etaTo?: string })[]) {
      const w = etas.get(q.id);
      if (w) {
        q.etaFrom = new Date(w.etaFromMs).toISOString();
        q.etaTo = new Date(w.etaToMs).toISOString();
        maxTo = Math.max(maxTo, w.etaToMs);
      }
    }
    queueEtaDoneBy = maxTo ? new Date(maxTo).toISOString() : null;
  } catch {
    /* ETA is best-effort - the rows still carry notBefore */
  }

  // The LIVE pause state, on the same poll that carries the queue. The agent
  // switch used to read this once on mount and never again, so a session that
  // was paused later kept showing "Agents active" above a queue whose every row
  // said "Paused by you" - two states on one screen. One source, one truth.
  //
  // It carries its VERSION too. This poll is answered by whichever Cloud Run
  // instance picks it up, and each caches pause state for 30s - so right after a
  // resume, an instance that has not seen the write answers with the old value.
  // That answer is not wrong, it is OLD, and without a version the client could
  // not tell: it applied it and the switch flipped back to "paused" on its own.
  // `known` is what the client has already applied; a cached value older than
  // that is refused and re-read.
  let sessionPaused = false;
  let sessionPausedVersion = 0;
  try {
    const { sessionPauseState } = await import("@/lib/session-flags");
    const knownVersion = Number(url.searchParams.get("pauseVersion") ?? 0);
    const state = await sessionPauseState(email, Number.isFinite(knownVersion) ? knownVersion : 0);
    sessionPaused = state.paused === true;
    sessionPausedVersion = state.version;
  } catch {}

  // Tombstoned shops (fetched above, before the queue was shaped). The digits
  // digest stays for older clients; the typed list is what the UI now reads -
  // the ACTOR decides the copy ("Removed by you" only for user-removed).
  const cancelled = cancelledShops.map((c) => c.digits);

  // "(unverified)" PURGE: historical rows stamped the legacy drill suffix into
  // vendor names - strip it from every feed item so it never renders again.
  for (const it of items) {
    if (it.vendorName) it.vendorName = cleanShopName(it.vendorName);
  }

  return NextResponse.json({
    items: items.slice(0, limit),
    queue,
    waHealth,
    introBudget,
    whyByVendor,
    vendorStates,
    countered, // J: vendorIds where the agent countered a shop quote
    queueEtaDoneBy, // W2: honest "all done by" (max etaTo across the queue)
    lastByVendor, // F4: {vendorId: {lastInboundText/At, lastOutboundText/At}}
    sessionPaused, // live kill-switch state, so the panel cannot contradict the queue
    sessionPausedVersion, // monotonic: the client only ever moves this forward
    cancelledNumbers: cancelled,
    cancelledShops, // typed: {digits, reason, at} - the actor behind each tombstone
    now: new Date().toISOString(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
// NEVER CACHE. This is the live activity poll and its URL is byte-identical on
// every tick, so without this the browser/CDN could serve the FIRST (empty)
// response forever - the app showed "Nothing on the wire yet" while WhatsApp
// was actively exchanging messages, and froze the queue ETA at a past time.
export const dynamic = "force-dynamic";
export const revalidate = 0;
