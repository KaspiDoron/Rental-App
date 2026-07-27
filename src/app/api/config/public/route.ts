import { NextResponse } from "next/server";
import { getConfig, getGoogleClientId } from "@/lib/runtime-config";
import { sessionSecretReady } from "@/lib/session";
import { authMethods, methodById } from "@/lib/auth/methods";
import { ADSENSE_PUBLISHER } from "@/lib/site";

// Must resolve at request time so Key-Vault values apply without a redeploy.
export const dynamic = "force-dynamic";

// Browser-safe configuration only. The Google OAuth client ID is public by
// design; secret keys are never exposed here.
export async function GET() {
  const [methods, mapsKey, adsense, testMode, scaleMode] = await Promise.all([
    // The provider list is built by the ONE registry (src/lib/auth/methods.ts)
    // that /api/auth/methods also uses, so this endpoint and the login screen
    // can no longer disagree about whether Google sign-in exists. The legacy
    // `googleClientId` field is derived from it rather than resolved separately -
    // two independent resolutions were how they drifted apart in the first place.
    authMethods({ sessionReady: sessionSecretReady, googleClientId: getGoogleClientId }),
    getConfig("GOOGLE_MAPS_API_KEY"),
    getConfig("ADSENSE_CLIENT"),
    getConfig("TEST_MODE"),
    getConfig("SCALE_MODE"),
  ]);
  const clientId = methodById(methods, "google")?.config?.clientId;
  const on = (v: string | undefined | null) =>
    ["on", "1", "true"].includes((v ?? "").trim().toLowerCase());
  const scaled = on(scaleMode);
  return NextResponse.json({
    // Kept for back-compat with any client still reading this field. New code
    // should use /api/auth/methods; this is the migration shim.
    googleClientId: clientId ?? null,
    // The full registry, so a consumer never has to re-derive "is Google on".
    authMethods: methods,
    mapsEnabled: Boolean(mapsKey),
    // The Key Vault can point the app at a DIFFERENT publisher without a
    // redeploy; with nothing set it falls back to the site's own account
    // rather than to null, so ad slots are live from the first deploy.
    adsenseClient: adsense || ADSENSE_PUBLISHER,
    testMode: on(testMode),
    // Client polling cadence: SCALE_MODE stretches intervals to cut function
    // invocations under load (a single instance has no workers to add).
    poll: scaled
      ? { activityMs: 15000, repliesMs: 20000, tagsMs: 300000 }
      : { activityMs: 6000, repliesMs: 8000, tagsMs: 120000 },
  });
}
