import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  connectionState,
  evolutionConfigured,
  wasEverConnected,
} from "@/lib/evolution";

// Current state of the user's personal WhatsApp session.
//
// A transient drop (Render sleeping/restarting) is NOT treated as "disconnected"
// - if the user has paired before, we report connected+reconnecting so the UI
// stays calm and the send path auto-resumes from saved credentials.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const available = await evolutionConfigured();
  if (!available) return NextResponse.json({ available: false, connected: false });

  const state = await connectionState(session.email);
  const paired = state === "open" ? true : await wasEverConnected(session.email);

  return NextResponse.json({
    available: true,
    state: state ?? "disconnected",
    // Linked from the user's perspective if live-open OR paired-and-reconnecting.
    connected: state === "open" || paired,
    live: state === "open",
    reconnecting: paired && state !== "open",
  });
}
