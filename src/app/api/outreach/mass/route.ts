import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp, whatsappConfigured } from "@/lib/whatsapp";
import {
  evolutionConfigured,
  hasSessionRow,
  ensureConnected,
  sendFromUser,
} from "@/lib/evolution";
import { placeDetails } from "@/lib/google";
import { sbInsert } from "@/lib/runtime-config";
import { killSwitchOn } from "@/lib/usage";
import { can } from "@/lib/entitlements";
import { digitsOnly } from "@/lib/phone";
import { planCapacity, batchWindowMs, BATCH_WINDOW_MINUTES } from "@/lib/wa/capacity";

// Mass bargain (Pro/Ultra): fire the RFQ at several shops in one tap. The
// anti-ban rate limiter still governs every single send - the batch simply
// stops when the budget runs out (the UI shows how many actually went).
//
// CAPACITY: each search session contacts at most the plan's rolling-window
// capacity in total (sent + queued), enforced HERE - the UI cap is a courtesy,
// this is the truth. free 10 / pro 15 / ultra 40 (see wa/capacity.ts).

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!can(session.plan, "mass-bargain")) {
    return NextResponse.json(
      { error: "Mass bargain is a Pro/Ultra feature.", upgrade: true },
      { status: 403 }
    );
  }
  if (await killSwitchOn()) {
    return NextResponse.json({ error: "Temporarily paused by the owner." }, { status: 503 });
  }

  // Plan-tiered batch + session caps. A single mass run (and a whole search
  // session) can reach up to the plan's rolling-window capacity of shops.
  const MAX_BATCH = planCapacity(session.plan).newContacts;
  const SESSION_SHOP_CAP = MAX_BATCH;

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  let vendors: {
    id: string;
    name: string;
    whatsapp?: string;
    placeId?: string;
    openNow?: boolean; // Google "open now" - the same truth the card shows
  }[] = Array.isArray(body.vendors) ? body.vendors.slice(0, MAX_BATCH) : [];
  if (!message || vendors.length === 0) {
    return NextResponse.json({ error: "message and vendors required" }, { status: 400 });
  }
  // RFQ INTEGRITY: this route stamps every stored opener with kind:"rfq", so it
  // MUST carry a real rfq or the thread has no anchor - a shop reply then reads
  // as "RFQ anchor MISSING" (the live Eagle's Eye drop) and every strategic-wait
  // wakeup dies. Fail loudly instead of storing a null-rfq cold opener.
  const rfqOk =
    body.rfq &&
    typeof body.rfq === "object" &&
    typeof (body.rfq as { durationDays?: unknown }).durationDays === "number";
  if (!rfqOk) {
    return NextResponse.json(
      { error: "rfq required (a cold opener must carry its structured request)" },
      { status: 400 }
    );
  }

  // Per-SESSION cap (backend truth, cannot be bypassed by repeat taps): count
  // the distinct shops already contacted or queued since this search session
  // started, and only allow the remainder. The session boundary is the user's
  // latest `searches` row - the same signal the deals dashboard groups by.
  try {
    const { sbSelect } = await import("@/lib/runtime-config");
    const enc = encodeURIComponent(session.email);
    const lastSearch = await sbSelect<{ created_at: string }>(
      "searches",
      `select=created_at&user_email=eq.${enc}&order=created_at.desc&limit=1`
    );
    const sinceIso = lastSearch[0]?.created_at ?? new Date(Date.now() - 86400000).toISOString();
    const [sentRows, queuedRows] = await Promise.all([
      sbSelect<{ to_number: string }>(
        "whatsapp_messages",
        `select=to_number&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&received_at=gte.${sinceIso}&limit=200`
      ).catch(() => []),
      sbSelect<{ to_number: string }>(
        "wa_outbox",
        `select=to_number&sender_key=eq.${enc}&limit=50`
      ).catch(() => []),
    ]);
    const contacted = new Set([
      ...sentRows.map((r) => r.to_number),
      ...queuedRows.map((r) => r.to_number),
    ]);
    const allowance = Math.max(0, SESSION_SHOP_CAP - contacted.size);
    if (allowance === 0) {
      return NextResponse.json({
        results: [],
        sent: 0,
        queued: 0,
        capReached: true,
        cap: SESSION_SHOP_CAP,
        error: `This search already reached its ${SESSION_SHOP_CAP}-shop beta limit - replies from the contacted shops keep flowing in.`,
      });
    }
    vendors = vendors.slice(0, allowance);
  } catch {
    /* cap check is best-effort - the MAX_BATCH slice still bounds the run */
  }

  const verdict = await runSafety(message);
  if (!verdict.allowed) {
    return NextResponse.json({ error: verdict.reason ?? "Blocked." }, { status: 400 });
  }

  // Gate on EVER-PAIRED, not the live socket - a transient host outage must not
  // kill the whole batch with "Connect your WhatsApp first". A parked batch
  // drains when the host recovers; connect:true is only for a never-linked user.
  const personal =
    (await evolutionConfigured()) && (await hasSessionRow(session.email));
  const cloud = await whatsappConfigured();
  if (!personal && !cloud) {
    return NextResponse.json({ error: "Connect your WhatsApp first.", connect: true }, { status: 400 });
  }
  // Resume a dropped session before the batch (best-effort).
  if (personal) await ensureConnected(session.email, 6000);

  // ULTRA local-language: localize the batch message ONCE up front (the guard
  // then varies it per shop). English fallback if the AI is unavailable.
  let batchMessage = message;
  let englishGloss: string | undefined;
  if (Boolean(body.localLang) && session.plan === "ultra") {
    const { localizeMessage } = await import("@/lib/agents");
    const localized = await localizeMessage(message, String(body.region ?? "") || undefined);
    batchMessage = localized.text;
    if (localized.english && localized.text !== message) englishGloss = localized.english;
    if (!localized.localized) {
      // Documented English fallback (after retry) - never a silent flip.
      await sbInsert("agent_events", [
        {
          kind: "localize-fallback",
          vendor_id: "",
          vendor_name: "(mass bargain)",
          detail: JSON.stringify({
            email: session.email,
            region: String(body.region ?? ""),
            reason: "AI localization unavailable after retry - batch sent in English",
          }).slice(0, 800),
        },
      ]).catch(() => {});
    }
  }

  const { guardOutbound, afterSend, claimForSend, releaseSendClaim } = await import(
    "@/lib/wa-guard"
  );
  const { batchStagger, gaussianUnit, HARD_MIN_GAP_SEC } = await import("@/lib/wa/pacing");
  const { randomBytes } = await import("crypto");
  const results: {
    id: string;
    sent: boolean;
    queued?: boolean;
    queuedUntil?: string;
    queuedReason?: string;
    reason?: string;
    text?: string;
    gloss?: string;
  }[] = [];

  // HUMAN-PACED BATCH: only the FIRST shop is contacted right now; every
  // later shop is parked with a durable, jittered 45-75s stagger
  // (wa_outbox.not_before survives restarts/redeploys). Ten messages leaving
  // at the same timestamp is a robotic signature no real traveller produces -
  // and the drain re-runs the full guard per row at its own time, so hours/
  // caps/tombstones still apply at the actual send moment.
  const batchId = randomBytes(6).toString("hex");
  // CAP-AWARE stagger: space the first hourly-cap shops ~90s apart (they send
  // promptly), then jump the overflow to the next hour window - so each parked
  // row's not_before is the REAL time the drain will honor. The old flat 45-75s
  // stagger stamped every shop "any minute", then the drain hit the hourly cap
  // and silently re-stamped the overflow an hour out (the "it said 17:34 then
  // 18:34" bug). Using the sender's conservative effective cap keeps the stamps
  // honest and stable.
  const { effectiveHourlyCap, getPolicies } = await import("@/lib/wa-guard");
  // A FAILED READ MUST NOT RESCHEDULE THE BATCH. This used to fall back to a
  // literal 3, which is smaller than every plan's conversation budget - so a
  // transient Supabase blip turned a 3-minute batch of 8 shops into three
  // hour-groups spanning an afternoon, with nothing in the logs to say why. The
  // plan's own capacity is a known constant and is the only honest fallback.
  const planHourCap = planCapacity(session.plan).hourCap;
  const hourCap = await effectiveHourlyCap(session.email, session.plan).catch(() => planHourCap);
  // The gap the anti-ban policy ASKS for. batchStagger may compress it (never
  // below the hard floor) when honouring it would break the batch promise.
  const gapSec = await getPolicies()
    .then((p) => Math.max(HARD_MIN_GAP_SEC, p.min_gap_seconds))
    .catch(() => 12);
  // SCHEDULE TO THE DEADLINE, NOT TO THE GAP. The whole batch is on its way
  // inside BATCH_WINDOW_MINUTES; see lib/wa/capacity for why that promise had to
  // become a thing the code holds rather than an outcome it hoped for. Gaussian
  // (bell-curve) jitter keeps the gaps human-shaped inside whatever the fitted
  // gap turns out to be.
  const schedule = batchStagger({
    count: vendors.length,
    hourCap,
    gapSec,
    windowMs: batchWindowMs(),
    rand: gaussianUnit,
  });
  const offsets = schedule.offsets;
  const batchStart = Date.now();
  // The stagger index counts only shops that ACTUALLY enter the send stream -
  // never the ones skipped for no-phone, dedupe or tomorrow-deferral. So the
  // first sendable shop is always the immediate send (offset 0), and gaps
  // stay a tight 45-75s regardless of how many earlier shops were skipped.
  let sendIndex = 0;

  // MODULE 4 - PER-SHOP COMPILED OPENERS. The root cause of the "identical
  // message to every shop" spam fingerprint was this route sending ONE stored
  // string to the whole batch. Each shop now gets its own deterministic
  // variation-matrix compile (seed = user|vendor|batchId), checked through the
  // global-uniqueness guard (in-batch + cross-fleet signature window). Ultra
  // local-language localizes PER SHOP. Legacy callers without an rfq in the
  // body keep the old single-message behavior.
  const rfqForCompile =
    body.rfq &&
    typeof body.rfq === "object" &&
    typeof (body.rfq as { durationDays?: unknown }).durationDays === "number"
      ? (body.rfq as import("@/lib/types").StructuredRFQ)
      : null;
  const compiledRecent: string[] = [];
  const wantLocalLang = Boolean(body.localLang) && session.plan === "ultra";
  const openerFor = async (vendorId: string, shopDigits: string): Promise<{ text: string; gloss?: string }> => {
    if (!rfqForCompile) return { text: opener.text, gloss: englishGloss };
    const { compileOpener } = await import("@/lib/copy/promptCompiler");
    const { openerSeed } = await import("@/lib/copy/matrix");
    const { regionForShop } = await import("@/lib/copy/region");
    const { ensureGloballyUnique } = await import("@/lib/graph/uniqueness");
    // Region from the SHOP's phone (authoritative), label only as fallback - so
    // a +84 shop never gets a Filipino sign-off.
    const shopRegion = regionForShop(shopDigits, String(body.region ?? ""));
    const english = compileOpener(rfqForCompile, openerSeed(session.email, vendorId, batchId), shopRegion);
    const unique = await ensureGloballyUnique(english, compiledRecent);
    compiledRecent.push(unique.text);
    if (!wantLocalLang) return { text: unique.text };
    const { localizeMessage } = await import("@/lib/agents");
    const localized = await localizeMessage(unique.text, shopRegion);
    return localized.localized
      ? { text: localized.text, gloss: localized.english ?? unique.text }
      : { text: unique.text };
  };

  // CLICK-TIME BUDGET TRUTH. The anti-ban engine only allows a limited number
  // of brand-new shop introductions per day. The old flow silently parked
  // over-budget messages behind fake near-term ETAs that crept forever
  // ("came back an hour later - everything moved 30 min further"). Now the
  // remaining budget is computed UP FRONT: shops inside it start immediately
  // (first now, the rest 45-75s apart), shops beyond it get an HONEST
  // tomorrow-morning slot and the user is told so in the response.
  const { newContactBudget, introHoldIso } = await import("@/lib/wa-guard");
  const budget = await newContactBudget(session.email, session.plan).catch(() => ({
    remaining: 99,
    cap: 99,
    windowHours: planCapacity(session.plan).windowHours,
    nextFreeAt: new Date().toISOString(),
  }));
  let newIntrosLeft = budget.remaining;
  // Which of these shops has this user EVER messaged before? (Known contacts
  // do not consume the introductions budget.)
  const { sbSelect } = await import("@/lib/runtime-config");
  const knownRows = await sbSelect<{ to_number: string }>(
    "wa_recipient_state",
    `select=to_number&sender_key=eq.${encodeURIComponent(session.email)}&limit=500`
  ).catch(() => []);
  const knownNumbers = new Set(knownRows.map((r) => r.to_number));
  // DEDUPE: a shop with a message already waiting must not get a second row
  // (the "same shop listed twice in the queue" report) - covers both re-runs
  // of mass bargain and duplicate vendors within one batch.
  const pendingRows = await sbSelect<{ to_number: string }>(
    "wa_outbox",
    `select=to_number&sender_key=eq.${encodeURIComponent(session.email)}&limit=100`
  ).catch(() => []);
  const alreadyQueued = new Set(pendingRows.map((r) => r.to_number));
  // Tighten the click-time budget by intros ALREADY parked to NEW shops (from a
  // prior tap / another instance): a committed-but-unsent introduction still
  // consumes a slot, so a double-tap can't each re-grant the full cap. The
  // per-row guard re-checks at drain regardless, so this only reduces queue
  // bloat - never over-sends.
  const parkedNewIntros = pendingRows.filter((r) => !knownNumbers.has(r.to_number)).length;
  newIntrosLeft = Math.max(0, newIntrosLeft - parkedNewIntros);
  let deferredTomorrow = 0;

  for (const v of vendors) {
    let to = (v.whatsapp ?? "").trim();
    if (!to && v.placeId) to = (await placeDetails(v.placeId))?.phone ?? "";
    if (!to) {
      results.push({ id: v.id, sent: false, reason: "no-phone" });
      continue;
    }
    const digits = digitsOnly(to);
    // The user explicitly selected this shop for the mass run - that decision
    // re-opens a previously removed/cancelled recipient.
    {
      const { clearCancellation } = await import("@/lib/wa/cancellations");
      await clearCancellation(session.email, digits).catch(() => {});
    }

    // Per-shop compiled opener (falls back to the legacy single message when
    // the caller sent no rfq). Computed before meta so the gloss rides along.
    const opener = await openerFor(v.id, digits);
    const meta = {
      sender: session.email,
      vendorId: v.id,
      vendorName: v.name,
      kind: "rfq",
      round: 0,
      rfq: body.rfq ?? null,
      region: String(body.region ?? ""),
      plan: session.plan,
      localLang: Boolean(body.localLang) && session.plan === "ultra",
      batchId,
      batchSize: vendors.length,
      // On queued rows the thread peek reads the gloss from outbox meta.
      ...((opener.gloss ?? englishGloss) ? { englishGloss: opener.gloss ?? englishGloss } : {}),
    };

    // DEDUPE: this shop already has a message waiting - never add a second.
    if (alreadyQueued.has(digits)) {
      results.push({ id: v.id, sent: false, queued: true, reason: "already-queued" });
      continue;
    }
    alreadyQueued.add(digits);

    // BUDGET: a brand-new shop beyond today's introductions budget gets the
    // honest tomorrow-morning slot - told to the user, never a fake ETA.
    const isNewIntro = !knownNumbers.has(digits);
    if (isNewIntro && newIntrosLeft <= 0) {
      // Beyond this window's introductions budget: park on the ROLLING-window
      // anchor (when the next slot frees - at most windowHours away), not a
      // "tomorrow morning" wall. The drain re-runs the full guard at that time.
      const notBefore = await introHoldIso(
        session.email,
        digits,
        String(body.region ?? "") || undefined,
        session.plan
      );
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          body: opener.text,
          not_before: notBefore,
          meta: { ...meta, reason: "introductions full - refreshes soon" },
        },
      ]);
      deferredTomorrow++;
      results.push({
        id: v.id,
        sent: false,
        queued: parked,
        queuedUntil: parked ? notBefore : undefined,
        queuedReason: parked ? "introductions full - refreshes soon" : undefined,
        reason: parked ? "queued" : "queue-unavailable",
      });
      continue;
    }
    if (isNewIntro) newIntrosLeft--;

    // This shop is entering the send stream - claim its stagger slot. The
    // first eligible shop (slot 0) sends immediately; the rest are parked.
    const slot = sendIndex++;
    // Shops after the first: park with the stagger - the guard runs at drain.
    if (slot > 0) {
      const notBefore = new Date(batchStart + offsets[slot]).toISOString();
      const parked = await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          body: opener.text,
          not_before: notBefore,
          meta: { ...meta, reason: "batch-spacing" },
        },
      ]);
      results.push({
        id: v.id,
        sent: false,
        queued: parked,
        queuedUntil: parked ? notBefore : undefined,
        queuedReason: parked ? "batch-spacing" : undefined,
        reason: parked ? "queued" : "queue-unavailable",
      });
      continue;
    }

    // Shop 1: the immediate, fully-guarded send.
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text: opener.text,
      auto: true,
      queueIfBlocked: true,
      region: String(body.region ?? "") || undefined,
      // Google truth first: an open shop is NEVER queued as "closed". Only
      // when openNow is unknown does the local-clock window apply.
      shopOpenNow: typeof v.openNow === "boolean" ? v.openNow : undefined,
      meta,
    });
    if (!guard.allow) {
      results.push({
        id: v.id,
        sent: false,
        queued: Boolean(guard.queuedUntil),
        queuedUntil: guard.queuedUntil ? new Date(guard.queuedUntil).toISOString() : undefined,
        // Raw guard reason so the card can explain the hold honestly.
        queuedReason: guard.queuedUntil ? guard.reason ?? undefined : undefined,
        reason: guard.queuedUntil ? "queued" : guard.reason,
      });
      continue;
    }
    // Atomic slots: no concurrent duplicate, no gap-window race.
    const claim = await claimForSend(session.email, digits, guard.text, true);
    if (!claim.ok) {
      const notBefore = new Date(batchStart + 60_000).toISOString();
      await sbInsert("wa_outbox", [
        {
          sender_key: session.email,
          to_number: digits,
          body: guard.text,
          not_before: notBefore,
          meta: { ...meta, reason: claim.kind === "duplicate" ? "batch-spacing" : "human pacing gap" },
        },
      ]).catch(() => {});
      results.push({
        id: v.id,
        sent: false,
        queued: true,
        queuedUntil: notBefore,
        queuedReason: "human pacing gap",
        reason: "queued",
      });
      continue;
    }

    let ok = false;
    let reason: string | undefined;
    if (personal) {
      const r = await sendFromUser(session.email, digits, guard.text);
      ok = r.ok;
      reason = r.error;
      if (r.rateLimited) {
        await releaseSendClaim(session.email, digits, guard.text).catch(() => {});
        results.push({ id: v.id, sent: false, reason: "rate-limit" });
        break; // budget exhausted - stop the batch quietly
      }
    } else if (cloud) {
      const r = await sendWhatsApp(to, guard.text);
      ok = r.ok && r.channel === "cloud-api";
      reason = r.error;
    }
    if (ok) {
      await afterSend(session.email, digits);
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: guard.text,
          type: "text",
          direction: "outbound",
          raw: {
            channel: personal ? "personal-wa" : "cloud-api",
            ok: true,
            ...meta,
          },
        },
      ]);
    } else {
      await releaseSendClaim(session.email, digits, guard.text).catch(() => {});
    }
    results.push({
      id: v.id,
      sent: ok,
      reason: ok ? undefined : reason ?? "not-on-whatsapp",
      // Give the traveller the EXACT text we sent + its faithful English gloss
      // so the status panel shows what really went out (never a paraphrase).
      text: ok ? guard.text : undefined,
      gloss: ok ? englishGloss : undefined,
    });
  }

  // LIVENESS: kick the self-chaining drain so the staggered batch keeps
  // progressing even if the user locks their phone right now (fire-and-
  // forget; the activity polls and the ping cron remain the backstops).
  try {
    const { webhookToken } = await import("@/lib/evolution");
    const token = await webhookToken();
    const origin = new URL(req.url).origin;
    if (token) {
      fetch(`${origin}/api/wa/tick?token=${encodeURIComponent(token)}&hop=0`).catch(() => {});
    }
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    results,
    sent: results.filter((r) => r.sent).length,
    queued: results.filter((r) => r.queued).length,
    // Honest budget summary for the UI: how many shops start now vs deferred,
    // the rolling-window size, and when the next introduction slot frees.
    deferredTomorrow,
    // THE PROMISE, STATED BACK. The last message of this batch is stamped
    // within this many minutes - so a UI (or a test, or the owner reading a
    // response) can hold the schedule to it instead of inferring it.
    batchWindowMinutes: BATCH_WINDOW_MINUTES,
    batchGapSeconds: schedule.gapSecUsed,
    /** Shops beyond the sender's hourly ceiling - honestly scheduled later. */
    batchOverflow: schedule.overflow,
    introBudget: {
      remaining: newIntrosLeft,
      cap: budget.cap,
      windowHours: budget.windowHours,
      nextFreeAt: budget.nextFreeAt,
    },
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
