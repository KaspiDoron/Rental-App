import { NextResponse } from "next/server";
import { pingAllHosts, webhookToken } from "@/lib/evolution";

export const dynamic = "force-dynamic";

// Keep-awake for the Evolution API host pool (free tiers sleep after ~15 min).
// Point cron-job.org (and a couple of backup free cron pingers) at
//   https://<app>/api/wa/ping?token=<webhook token>
// every 5-10 minutes. The token (same one the Evolution webhook uses, shown
// in Admin -> Keys guidance) stops anonymous callers from forcing outbox
// drains and host pings.
export async function GET(req: Request) {
  const expected = await webhookToken();
  if (expected) {
    const token = new URL(req.url).searchParams.get("token");
    if (token !== expected) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  const hosts = await pingAllHosts();

  // GUARANTEED queue drain: delayed agent replies (human thinking-time) and
  // business-hours/paced sends normally flush on webhook + app-poll activity.
  // This cron is the safety net so a queued message ALWAYS goes out on time
  // even when no user has the app open and no new shop reply arrives.
  let drained = 0;
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    drained = await drainOutbox((senderKey, to, text, lane) => sendFromUser(senderKey, to, text, true, { lane }));
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text, true, { lane: "reply" })).catch(
      () => {}
    );
  } catch {
    /* best-effort */
  }

  // INBOUND RECOVERY, on the one runner that actually exists in production.
  // The BullMQ inbound-recovery sweep lives on the (still-unprovisioned)
  // workers VM, and the only other syncInboundReplies caller is the client's
  // replies poll - i.e. with the app closed there was NO backstop at all: a
  // reply the webhook missed stayed missed until the owner opened the app.
  // This cron fires every minute (render.yaml wd-queue-drain), so a bounded
  // sweep here gives every recently-active user app-closed recovery.
  let synced = 0;
  try {
    const { recentActiveSenders, syncInboundReplies } = await import("@/lib/wa-sync");
    const { pickSweepEmails } = await import("@/lib/wa/sweep");
    const senders = await recentActiveSenders();
    const minute = Math.floor(Date.now() / 60_000);
    for (const email of pickSweepEmails(senders, minute, 3)) {
      synced += await syncInboundReplies(email).catch(() => 0);
    }
  } catch {
    /* best-effort */
  }

  // Extend this ping's reach: kick the self-chaining drain so one cron hit
  // keeps a staggered batch progressing for the following ~30 minutes even
  // between cron intervals. AWAITED to the point of leaving the instance - a
  // detached fetch here is exactly the call Cloud Run freezes (see wa/kick.ts).
  if (expected) {
    const { kickDispatcher } = await import("@/lib/wa/kick");
    const { selfKickOrigin } = await import("@/lib/request-origin");
    const origin = await selfKickOrigin(req);
    await kickDispatcher(
      `${origin}/api/wa/tick?token=${encodeURIComponent(expected)}&hop=0`
    );
  }

  // THE HEARTBEAT ITSELF IS THE THING TO WATCH.
  //
  // This route is the only mechanism in the whole system that can move a queued
  // message or a due wakeup while the owner's phone is in their pocket. If the
  // scheduler behind it ever stops - a job deleted, a token rotated, a cron
  // service that silently lapsed - the app does not break loudly. It goes quiet,
  // which is indistinguishable from "the shops are slow today".
  //
  // So every hit leaves a dated mark. /api/admin/deploy-info reads the newest
  // one and reports its age, so "is the heartbeat alive?" is a question the
  // owner can answer from their phone in one look.
  try {
    const { sbInsert } = await import("@/lib/runtime-config");
    await sbInsert("agent_events", [
      { kind: "cron-ping", detail: JSON.stringify({ drained, synced, hosts: hosts.length }) },
    ]);
  } catch {
    /* the ping still did its work; the breadcrumb is best-effort */
  }

  return NextResponse.json({
    ok: true,
    hosts: hosts.length,
    awake: hosts.filter((h) => h.ok).length,
    drained,
    synced,
    at: new Date().toISOString(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
