import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { webhookToken } from "@/lib/evolution";

// The cron ping + Evolution webhook both carry a token derived server-side
// from SESSION_SECRET (webhookToken()). The owner never invents it - they just
// copy the ready-made URLs from here into cron-job.org / Meta. Owner-visible
// only (it contains the security token).
export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const origin = new URL(req.url).origin;
  const token = await webhookToken();
  if (!token) {
    // No hosts configured, or SESSION_SECRET missing/weak in production.
    return NextResponse.json({
      tokenReady: false,
      origin,
      reason:
        "Set a strong SESSION_SECRET (>= 16 chars) in your host env and connect at least one WhatsApp host - the ping token is derived from it.",
    });
  }

  return NextResponse.json({
    tokenReady: true,
    origin,
    pingUrl: `${origin}/api/wa/ping?token=${token}`,
    webhookUrl: `${origin}/api/webhooks/evolution?token=${token}`,
  });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
