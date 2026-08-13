import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbSelectStrict, sbInsert } from "@/lib/runtime-config";
import { digitsOnly } from "@/lib/phone";
import { killSwitchOn } from "@/lib/usage";
import { groupSearchSessions, sessionIdOf } from "@/lib/session-life";
import { recheckMessage } from "@/lib/wa/recheck-message";

export const dynamic = "force-dynamic";

// "IS THAT PRICE STILL GOOD?" - the thing a past trip is actually for.
//
// Trips could re-open an old hunt's workspace, but every number on it was
// frozen at whatever the shop said days or weeks ago. A traveller coming back
// to a hunt has exactly one question, and it is the same question for every
// shop on the list, so asking it should be one tap - not ten conversations
// re-opened by hand.
//
// This re-asks each shop from ONE past session whether its own last quote still
// stands. Three things make that safe:
//
//   * It is never a cold contact. Only numbers already in this user's own
//     outbound history are eligible, so nothing here can start a new thread -
//     it continues one the shop already answered.
//   * It goes through `guardOutbound` exactly like every other send: pacing,
//     the session pause, human takeover, cancellation tombstones and the
//     duplicate suppressor all apply, and anything held is parked in the
//     outbox and drains on its own.
//   * It quotes the shop's OWN number back to them. No invented figure ever
//     reaches a shop - the price comes from the offers row we stored when they
//     said it.

const GROUP_GAP_MS = 30 * 60_000;
/** One re-check per shop per day - asking twice reads as a bot, and is rude. */
const RECHECK_WINDOW_MS = 20 * 3600_000;

interface OfferRow {
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  currency: string | null;
  created_at: string;
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (await killSwitchOn()) {
    return NextResponse.json({ error: "Temporarily paused by the owner." }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const startMs = Date.parse(String(body.ts ?? ""));
  if (!Number.isFinite(startMs)) {
    return NextResponse.json({ error: "ts (session start) required" }, { status: 400 });
  }
  const enc = encodeURIComponent(session.email);

  // The session window, grouped exactly the way the Trips list groups it, so
  // "this hunt" means the same thing on both sides.
  // `id` and `source` were not even SELECTED here, so this route could not tell
  // a hunt from a request-build and grouped analytics rows as sessions. That is
  // a third way its boundaries drifted from the Trips list's - on top of the
  // duplicated loop and the timestamp match. All three are gone.
  type RecheckRow = {
    id: number;
    source: string | null;
    created_at: string;
    rfq: { durationDays?: number } | null;
  };
  const searches = await sbSelect<RecheckRow>(
    "searches",
    `select=id,source,created_at,rfq&user_email=eq.${enc}&order=created_at.desc&limit=40`
  ).catch(() => [] as RecheckRow[]);
  const groups = groupSearchSessions(searches);
  const sid = Number(body.sid);
  const gi = Number.isFinite(sid)
    ? groups.findIndex((g) => sessionIdOf(g) === sid)
    : groups.findIndex((g) => Math.abs(Date.parse(g[0].created_at) - startMs) < 1000);
  if (gi < 0) return NextResponse.json({ error: "That hunt is no longer available." }, { status: 404 });
  const start = Date.parse(groups[gi][0].created_at);
  const end = gi === 0 ? Infinity : Date.parse(groups[gi - 1][0].created_at);

  // A CLEARED HUNT CANNOT BE RE-CHECKED - the clear tombstoned its recipients,
  // so every send this route queued would die at the guard while the response
  // cheerfully reported "Asking N shops". Same gate as restore, same bounds
  // (marker after this group's newest row, before the next group), and STRICT
  // for the same reason: unknown must refuse, not message.
  const groupEndIso = groups[gi][groups[gi].length - 1].created_at;
  const nextGroupIso = gi > 0 ? groups[gi - 1][0].created_at : null;
  const closedRead = await sbSelectStrict<{ received_at: string }>(
    "whatsapp_messages",
    `select=received_at&to_number=eq.session&raw->>sender=eq.${enc}&raw->>kind=eq.session-closed` +
      `&received_at=gt.${encodeURIComponent(groupEndIso)}` +
      (nextGroupIso ? `&received_at=lt.${encodeURIComponent(nextGroupIso)}` : "") +
      `&order=received_at.desc&limit=1`
  );
  if ("error" in closedRead && closedRead.error === "unavailable") {
    return NextResponse.json({ error: "Could not reach your shops just now. Try again." }, { status: 503 });
  }
  if ("rows" in closedRead && closedRead.rows.length) {
    return NextResponse.json({ error: "You cleared this hunt - its shops are no longer messaged." }, { status: 404 });
  }
  const days =
    [...groups[gi]].reverse().find((r) => typeof r.rfq?.durationDays === "number")?.rfq
      ?.durationDays ?? null;

  // Shops we MESSAGED in that window, with the last price each of them gave.
  const [outbound, offers] = await Promise.all([
    sbSelect<{
      to_number: string;
      received_at: string;
      raw: { vendorId?: string; vendorName?: string } | null;
    }>(
      "whatsapp_messages",
      `select=to_number,received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&to_number=not.in.(session,takeover,cancel)&order=received_at.desc&limit=200`
    ).catch(() => []),
    sbSelect<OfferRow>(
      "offers",
      `select=vendor_id,vendor_name,price_per_day,currency,created_at&user_email=eq.${enc}&simulated=eq.false&order=created_at.desc&limit=200`
    ).catch(() => []),
  ]);

  const inWindow = (iso: string) => {
    const ms = Date.parse(iso);
    return ms >= start - 1000 && ms < end;
  };

  const priceByVendor = new Map<string, OfferRow>();
  for (const o of offers) {
    const id = o.vendor_id || o.vendor_name;
    if (!id || !inWindow(o.created_at) || priceByVendor.has(id)) continue;
    if (o.price_per_day && o.price_per_day > 0) priceByVendor.set(id, o);
  }

  const targets = new Map<string, { name: string; vendorId?: string }>();
  for (const m of outbound) {
    if (!inWindow(m.received_at)) continue;
    const digits = digitsOnly(m.to_number);
    if (digits.length < 6 || targets.has(digits)) continue;
    targets.set(digits, { name: m.raw?.vendorName || digits, vendorId: m.raw?.vendorId });
  }
  if (targets.size === 0) {
    return NextResponse.json({ error: "No shops were messaged in that hunt.", asked: 0 });
  }

  // Already re-checked today? Do not ask the same shop twice.
  const recent = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${enc}&raw->>kind=eq.recheck&received_at=gte.${encodeURIComponent(
      new Date(Date.now() - RECHECK_WINDOW_MS).toISOString()
    )}&limit=200`
  ).catch(() => []);
  const alreadyAsked = new Set(recent.map((r) => digitsOnly(r.to_number)));

  const { guardOutbound, afterSend } = await import("@/lib/wa-guard");
  const { sendFromUser } = await import("@/lib/evolution");

  let sent = 0;
  let queued = 0;
  let skipped = 0;
  const detail: { name: string; state: "sent" | "queued" | "skipped"; reason?: string }[] = [];

  for (const [digits, info] of targets) {
    if (alreadyAsked.has(digits)) {
      skipped += 1;
      detail.push({ name: info.name, state: "skipped", reason: "already asked today" });
      continue;
    }
    const known = info.vendorId ? priceByVendor.get(info.vendorId) : undefined;
    const text = recheckMessage({
      pricePerDay: known?.price_per_day ?? null,
      currency: known?.currency ?? null,
      days,
    });
    const meta = {
      kind: "recheck",
      vendorId: info.vendorId ?? null,
      vendorName: info.name,
    };
    // auto:true - this is the agent acting on the traveller's behalf, so it
    // must obey every automated-send veto (pause, takeover, cancellation) and
    // be paced like one. queueIfBlocked parks anything held; the outbox drains.
    const guard = await guardOutbound({
      senderKey: session.email,
      toDigits: digits,
      text,
      auto: true,
      queueIfBlocked: true,
      meta,
    });
    if (!guard.allow) {
      if (guard.queuedUntil) {
        queued += 1;
        detail.push({ name: info.name, state: "queued" });
      } else {
        skipped += 1;
        detail.push({ name: info.name, state: "skipped", reason: guard.reason });
      }
      continue;
    }
    // THE MUTEX, ON THIS PATH TOO. guardOutbound's checks are read-then-act by
    // its own documentation and cannot serialize anything; this route used to
    // go straight from the verdict to the wire. It re-asks every shop from a
    // past session at once, so it is precisely the batch most likely to land on
    // a shop the live agent is already mid-sentence with.
    const { claimForSend } = await import("@/lib/wa-guard");
    const claim = await claimForSend(session.email, digits, guard.text, true, true);
    if (!claim.ok) {
      skipped += 1;
      detail.push({
        name: info.name,
        state: "skipped",
        reason:
          claim.kind === "duplicate"
            ? "already going out"
            : "your agent is mid-message with this shop",
      });
      continue;
    }
    const r = await sendFromUser(session.email, digits, guard.text).catch(() => ({
      ok: false,
      error: "send failed",
    }));
    if (r.ok) {
      sent += 1;
      await afterSend(session.email, digits);
      await sbInsert("whatsapp_messages", [
        {
          to_number: digits,
          body: guard.text,
          type: "text",
          direction: "outbound",
          raw: { channel: "personal-wa", sender: session.email, ok: true, ...meta },
        },
      ]).catch(() => {});
      detail.push({ name: info.name, state: "sent" });
    } else {
      skipped += 1;
      detail.push({ name: info.name, state: "skipped", reason: r.error });
    }
  }

  return NextResponse.json({
    asked: sent + queued,
    sent,
    queued,
    skipped,
    detail: detail.slice(0, 40),
  });
}
