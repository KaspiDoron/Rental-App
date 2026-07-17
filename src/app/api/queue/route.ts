import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { queueReasonLabel } from "@/lib/queue-reason";

// USER-facing queued-message viewer (bug #9). Every traveller can see the
// messages the anti-ban engine is holding for them - with the REAL reason
// (shop closed / safe pacing / daily limit / paused), never a made-up one -
// and decide: WAIT, or REMOVE them. Strictly scoped to the signed-in user's
// own sender_key.

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

  // Opportunistic drain: this endpoint is polled while the app is open, so
  // due messages actually leave even without the external cron.
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    void drainOutbox((email, to, text) => sendFromUser(email, to, text)).catch(() => {});
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    void drainGraphWakeups((email, to, text) => sendFromUser(email, to, text)).catch(() => {});
  } catch {
    /* draining is best-effort */
  }

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

  if (body.action === "delete" && (body.id || body.vendorId)) {
    const { sbDeleteReturning } = await import("@/lib/runtime-config");
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
    if (removed.length > 0) {
      return NextResponse.json({ ok: true, removed: true, count: removed.length });
    }

    // 3) Nothing pending. Honest verdict: did it actually LEAVE (a real
    //    outbound in the last 15 min), or was there simply nothing left?
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
