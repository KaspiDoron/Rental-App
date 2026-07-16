import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { evolutionConfigured, connectionState, wasEverConnected } from "@/lib/evolution";
import { senderSafety } from "@/lib/wa-guard";

// Superset of /api/wa/status: socket state PLUS what the anti-ban guard is
// actually doing (safety pause, ban recovery, pacing queue). This is what
// stops the UI from claiming "connected, negotiating" while every automated
// send is silently held.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const available = await evolutionConfigured();
  if (!available) {
    return NextResponse.json({ available: false, connected: false, live: false, safety: null });
  }

  const [state, safety] = await Promise.all([
    connectionState(session.email),
    senderSafety(session.email),
  ]);
  const paired = state === "open" ? true : await wasEverConnected(session.email);

  return NextResponse.json({
    available: true,
    connected: state === "open" || paired,
    live: state === "open",
    reconnecting: paired && state !== "open",
    safety,
  });
}

export const maxDuration = 60;
