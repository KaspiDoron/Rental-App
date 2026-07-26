import { NextResponse } from "next/server";

// LIVENESS for the Cloud Run web service. Deliberately the cheapest endpoint in
// the app: no session, no Supabase, no Evolution, no LLM - just proof that this
// container can accept a request and run JavaScript.
//
// Why it must stay this thin: a probe that touches a dependency turns any
// dependency blip into a container restart, which is a self-inflicted outage.
// The rich, auth-gated diagnostics already live at /api/admin/health (Supabase,
// Maps, a real LLM round-trip, every Evolution host) - that one is for a human
// reading the admin panel, never for an automated probe.
//
// force-dynamic so it reports THIS instance right now rather than a value baked
// at build time.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "web",
    uptimeSec: Math.round(process.uptime()),
    at: new Date().toISOString(),
  });
}
