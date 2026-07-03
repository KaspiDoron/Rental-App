import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { connectionState, evolutionConfigured } from "@/lib/evolution";

// Current state of the user's personal WhatsApp session.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const available = await evolutionConfigured();
  if (!available) return NextResponse.json({ available: false, connected: false });

  const state = await connectionState(session.email);
  return NextResponse.json({
    available: true,
    state: state ?? "disconnected",
    connected: state === "open",
  });
}
