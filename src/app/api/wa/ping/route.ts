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
    drained = await drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text, true)).catch(
      () => {}
    );
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok: true,
    hosts: hosts.length,
    awake: hosts.filter((h) => h.ok).length,
    drained,
    at: new Date().toISOString(),
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
