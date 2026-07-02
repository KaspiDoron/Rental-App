import { NextResponse } from "next/server";
import { getConfig } from "@/lib/runtime-config";

// Must resolve at request time so Key-Vault values apply without a redeploy.
export const dynamic = "force-dynamic";

// Browser-safe configuration only. The Google OAuth client ID is public by
// design; secret keys are never exposed here.
export async function GET() {
  const [clientId, mapsKey, adsense] = await Promise.all([
    getConfig("GOOGLE_OAUTH_CLIENT_ID"),
    getConfig("GOOGLE_MAPS_API_KEY"),
    getConfig("ADSENSE_CLIENT"),
  ]);
  return NextResponse.json({
    googleClientId: clientId ?? null,
    mapsEnabled: Boolean(mapsKey),
    adsenseClient: adsense ?? null,
  });
}
