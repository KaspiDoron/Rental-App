import { NextResponse } from "next/server";
import { pingAllHosts } from "@/lib/evolution";

export const dynamic = "force-dynamic";

// Keep-awake for the Evolution API host pool (free tiers sleep after ~15 min).
// Point cron-job.org (and a couple of backup free cron pingers) at THIS url
// every 5-10 minutes: we ping EVERY configured host server-side and return a
// tiny JSON body, so cron-job.org never hits "output too large".
export async function GET() {
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
