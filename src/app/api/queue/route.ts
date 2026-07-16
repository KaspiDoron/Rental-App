import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbDelete } from "@/lib/runtime-config";

// USER-facing queued-message viewer (bug #9). Every traveller can see the
// messages the anti-ban engine is holding for them (shop closed / paced) and
// decide: WAIT for the shop to open, or REMOVE the queued message. Strictly
// scoped to the signed-in user's own sender_key - a user never sees or touches
// another user's queue. (The owner has a separate global view in Admin.)

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

  // Opportunistic drain: this endpoint is polled every ~20s while the app is
  // open, so due messages actually leave even without the external cron.
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
      // Friendly, user-facing reason (no anti-ban jargon).
      reason:
        at > now
          ? "Waiting for the shop to open - it sends automatically then."
          : "Sending shortly - open shops are messaged first.",
    };
  });

  return NextResponse.json({ items, total: items.length });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "delete" && body.id) {
    // Ownership guard: only delete a row that belongs to THIS user.
    // ATOMIC TRUTH: delete-with-return tells us whether WE actually removed
    // the row. If a concurrent drainer already claimed it (delete-returning
    // is the claim), the message is on its way - the client must know the
    // removal LOST the race instead of silently pretending it worked.
    const { sbDeleteReturning } = await import("@/lib/runtime-config");
    const removed = await sbDeleteReturning<{ id: number }>(
      "wa_outbox",
      `id=eq.${Number(body.id)}&sender_key=eq.${encodeURIComponent(session.email)}`
    ).catch(() => []);
    return NextResponse.json({ ok: true, removed: removed.length > 0 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
