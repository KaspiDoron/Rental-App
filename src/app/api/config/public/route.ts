import { NextResponse } from "next/server";
import { getConfig, getGoogleClientId } from "@/lib/runtime-config";

// Must resolve at request time so Key-Vault values apply without a redeploy.
export const dynamic = "force-dynamic";

// Browser-safe configuration only. The Google OAuth client ID is public by
// design; secret keys are never exposed here.
export async function GET() {
  const [clientId, mapsKey, adsense, testMode, scaleMode] = await Promise.all([
    // Resilient resolve: vault -> GOOGLE_OAUTH_CLIENT_ID env -> the PUBLIC env
    // name the build inlines. A vault miss (decrypt failure on a SESSION_SECRET
    // mismatch, unreachable Supabase, or key never pasted) no longer hides the
    // Google button - it falls through to whatever the host provides.
    getGoogleClientId(),
    getConfig("GOOGLE_MAPS_API_KEY"),
    getConfig("ADSENSE_CLIENT"),
    getConfig("TEST_MODE"),
    getConfig("SCALE_MODE"),
  ]);
  const on = (v: string | undefined | null) =>
    ["on", "1", "true"].includes((v ?? "").trim().toLowerCase());
  const scaled = on(scaleMode);
  return NextResponse.json({
    googleClientId: clientId ?? null,
    mapsEnabled: Boolean(mapsKey),
    adsenseClient: adsense ?? null,
    testMode: on(testMode),
    // Client polling cadence: SCALE_MODE stretches intervals to cut function
    // invocations under load (Vercel Hobby has no workers to add).
    poll: scaled
      ? { activityMs: 15000, repliesMs: 20000, tagsMs: 300000 }
      : { activityMs: 6000, repliesMs: 8000, tagsMs: 120000 },
  });
}
