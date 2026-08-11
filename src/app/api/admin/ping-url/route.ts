import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { webhookToken, canonicalWebhookOrigin } from "@/lib/evolution";
import { trustedRequestOrigin, requestOrigin, routableOrigin } from "@/lib/request-origin";

// The cron ping + Evolution webhook both carry a token derived server-side
// from SESSION_SECRET (webhookToken()). The owner never invents it - they just
// copy the ready-made URLs from here into cron-job.org / Meta. Owner-visible
// only (it contains the security token).
//
// Origin resolution (the 0.0.0.0 fix): APP_DOMAIN from the vault/env wins, then
// the proxy-forwarded public host, then the raw request URL. `needsDomain`
// flags when only an unroutable bind address is left, so the Command tab can
// surface the APP_DOMAIN quick-set instead of printing 0.0.0.0 URLs.
export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Allow-listed like every other forwarded-host consumer. This route only
  // DISPLAYS a URL rather than registering one, so the exposure is smaller -
  // but it prints a token-bearing URL, and leaving one caller trusting the raw
  // header is how the next person concludes the header is trustworthy.
  const forwarded = await trustedRequestOrigin(req);
  const canonical = await canonicalWebhookOrigin(forwarded ?? undefined).catch(() => null);
  const origin = canonical ?? forwarded ?? requestOrigin(req);
  const originSource =
    canonical && canonical !== forwarded ? "app-domain" : forwarded ? "forwarded" : "request";
  const needsDomain = !routableOrigin(origin);
  const token = await webhookToken();
  if (!token) {
    // No hosts configured, or SESSION_SECRET missing/weak in production.
    return NextResponse.json({
      tokenReady: false,
      origin,
      originSource,
      needsDomain,
      reason:
        "Set a strong SESSION_SECRET (>= 16 chars) in your host env and connect at least one WhatsApp host - the ping token is derived from it.",
    });
  }

  return NextResponse.json({
    tokenReady: true,
    origin,
    originSource,
    needsDomain,
    pingUrl: `${origin}/api/wa/ping?token=${token}`,
    webhookUrl: `${origin}/api/webhooks/evolution?token=${token}`,
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
