import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isSessionPaused, setSessionPaused } from "@/lib/session-flags";

// Pause / resume the whole search session ("Will, hold everything"). Paused:
// replies keep landing and are stored, but the agents send nothing - enforced
// server-side in the reply loop AND the outbound guard, not just in the UI.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "pause" ? "pause" : body.mode === "resume" ? "resume" : null;
  if (!mode) return NextResponse.json({ error: "mode must be 'pause' or 'resume'" }, { status: 400 });
  const ok = await setSessionPaused(session.email, mode === "pause");
  return NextResponse.json({ ok, paused: mode === "pause" });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ paused: (await isSessionPaused(session.email)) === true });
}
