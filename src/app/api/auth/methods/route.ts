import { NextResponse } from "next/server";
import { getGoogleClientId } from "@/lib/runtime-config";
import { sessionSecretReady } from "@/lib/session";
import { authMethods, emailOnlyMethods } from "@/lib/auth/methods";

// The login screen's provider probe, and nothing else.
//
// It exists as its own route because the login page used to ask
// /api/config/public - which awaits FIVE unrelated getConfig reads (maps,
// adsense, test mode, scale mode) purely to learn one client ID. On a cold
// instance that is a Supabase round trip the sign-in area waits behind for no
// reason. This endpoint resolves exactly what the sign-in area renders.
//
// Must resolve at request time so a Key-Vault paste applies without a redeploy.
export const dynamic = "force-dynamic";

export async function GET() {
  // A registry read that throws would blank the sign-in area - the exact failure
  // this whole capability exists to remove - so it degrades to the honest
  // email-only answer instead.
  let methods;
  try {
    methods = await authMethods({
      sessionReady: sessionSecretReady,
      googleClientId: getGoogleClientId,
    });
  } catch {
    methods = emailOnlyMethods();
  }
  return NextResponse.json(
    { methods },
    {
      headers: {
        // Matches runtime-config's 30s per-instance cache: caching longer would
        // out-live a Key-Vault change, shorter would pay for it twice.
        // `private` because the answer is per-deployment, not per-CDN-edge.
        "Cache-Control": "private, max-age=30",
      },
    }
  );
}
