import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { queueReasonLabel } from "@/lib/queue-reason";
import { digitsOnly } from "@/lib/phone";

// USER-facing queued-message viewer (bug #9). Every traveller can see the
// messages the anti-ban engine is holding for them - with the REAL reason
// (shop closed / safe pacing / daily limit / paused), never a made-up one -
// and decide: WAIT, or REMOVE them. Strictly scoped to the signed-in user's
// own sender_key.
//
// NOTE: this endpoint deliberately does NOT drain the outbox. Opening the
// queue to REVIEW messages must never be the event that SENDS them - the
// webhook, the activity/replies polls and the ping cron all drain already.

interface OutboxRow {
  id: number;
  sender_key: string;
  to_number: string;
  body: string;
  not_before: string;
  meta: { reason?: string; vendorName?: string; vendorId?: string; kind?: string } | null;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ items: [] }, { status: 401 });

  const rows = await sbSelect<OutboxRow>(
    "wa_outbox",
    `select=id,sender_key,to_number,body,not_before,meta&sender_key=eq.${encodeURIComponent(
      session.email
    )}&order=not_before.asc&limit=50`
  ).catch(() => []);

  const now = Date.now();
  const items = rows.map((r) => {
    const at = Date.parse(r.not_before);
    return {
      id: r.id,
      vendorId: r.meta?.vendorId ?? null,
      vendorName: r.meta?.vendorName ?? null,
      toNumber: r.to_number,
      notBefore: r.not_before,
      due: at <= now,
      kind: r.meta?.kind ?? null,
      // The guard's REAL stored reason, translated honestly.
      reason: at <= now ? "Sending shortly" : queueReasonLabel(r.meta?.reason),
      rawReason: r.meta?.reason ?? null,
    };
  });

  return NextResponse.json({ items, total: items.length });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "delete" && (body.id || body.vendorId || body.toNumber)) {
    const { sbDeleteReturning, sbDelete } = await import("@/lib/runtime-config");
    const vendorId = body.vendorId ? String(body.vendorId).slice(0, 200) : null;

    // 1) The row the user tapped (ownership-scoped).
    let removed = body.id
      ? await sbDeleteReturning<{ id: number; to_number: string }>(
          "wa_outbox",
          `id=eq.${Number(body.id)}&sender_key=eq.${encodeURIComponent(session.email)}`
        ).catch(() => [])
      : [];

    // 2) VENDOR-WIDE sweep: the drain loop re-queues held messages under NEW
    //    row ids (pacing re-checks), so deleting one stale id used to lose the
    //    race and the "removed" message popped right back. The user's intent
    //    is "do not message this shop" - remove EVERY pending row for it.
    if (vendorId) {
      const swept = await sbDeleteReturning<{ id: number; to_number: string }>(
        "wa_outbox",
        `sender_key=eq.${encodeURIComponent(session.email)}&meta->>vendorId=eq.${encodeURIComponent(
          vendorId
        )}`
      ).catch(() => []);
      removed = [...removed, ...swept];
    }

    // 3) MAKE IT PERMANENT. Deleting outbox rows alone is not enough: a
    //    strategic-wait wakeup would re-compose a brand-new message to the
    //    same shop. Tombstone every affected number (guardOutbound refuses
    //    automated sends to tombstoned recipients until the user explicitly
    //    re-initiates) and purge that thread's pending wakeups exactly.
    const digitsSet = new Set(removed.map((r) => r.to_number).filter(Boolean));
    if (body.toNumber) {
      const d = digitsOnly(String(body.toNumber));
      if (d) digitsSet.add(d);
    }
    const { cancelSends } = await import("@/lib/wa/cancellations");
    let tombstoneFailed = false;
    for (const digits of digitsSet) {
      const ok = await cancelSends(session.email, digits, "user-removed");
      if (!ok) tombstoneFailed = true;
      await sbDelete(
        "graph_wakeups",
        `kind=eq.tick&thread_key=eq.${encodeURIComponent(`${session.email}:${digits}`)}`
      ).catch(() => {});
    }

    // HONESTY over optimism: if the tombstone write could not be confirmed,
    // say so - rows may re-appear via a wakeup, and pretending otherwise is
    // the exact lie class this feature exists to kill. (Most common cause:
    // supabase/schema.sql has not been re-run to create wa_cancellations.)
    if (tombstoneFailed) {
      return NextResponse.json({
        ok: false,
        removed: removed.length > 0,
        count: removed.length,
        error:
          "The messages were removed from the queue, but the permanent stop could not be saved - it may retry later. (Database update pending.)",
      });
    }

    if (removed.length > 0) {
      return NextResponse.json({ ok: true, removed: true, count: removed.length });
    }

    // 4) Nothing pending. Honest verdict: did it actually LEAVE (a real
    //    outbound in the last 15 min), or was there simply nothing left?
    //    Either way the tombstone above now prevents any future auto-send.
    let sent = false;
    if (vendorId) {
      const recent = await sbSelect<{ id: number }>(
        "whatsapp_messages",
        `select=id&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          session.email
        )}&raw->>vendorId=eq.${encodeURIComponent(vendorId)}&received_at=gte.${encodeURIComponent(
          new Date(Date.now() - 15 * 60_000).toISOString()
        )}&limit=1`
      ).catch(() => []);
      sent = recent.length > 0;
    }
    return NextResponse.json({ ok: true, removed: !sent, sent });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
