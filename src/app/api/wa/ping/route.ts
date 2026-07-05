import { NextResponse } from "next/server";
import { getConfig } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

// Keep-awake endpoint for the Evolution API (Render's free tier sleeps after
// ~15 min of inactivity, which would drop every user's WhatsApp session).
//
// Point a cron-job.org job at THIS url every 10 minutes instead of pinging the
// Evolution server directly: we ping Evolution server-side to keep it warm and
// return a tiny JSON body, so cron-job.org never hits "output too large" and
// always sees a 200. Public by design - it exposes nothing sensitive.
export async function GET() {
  const url = (await getConfig("EVOLUTION_API_URL"))?.trim();
  let evolution: "awake" | "waking" | "unreachable" | "not-configured" = "not-configured";

  if (url) {
    try {
      const ctrl = new AbortController();
      // Return fast even on a cold start - the request still triggers Render's
      // wake-up, and the next 10-min ping will find it warm.
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url.replace(/\/$/, ""), {
        signal: ctrl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      evolution = res.status < 500 ? "awake" : "unreachable";
    } catch {
      // Aborted/cold-start still kicked off the wake-up on Render's side.
      evolution = "waking";
    }
  }

  return NextResponse.json({ ok: true, evolution, at: new Date().toISOString() });
}
