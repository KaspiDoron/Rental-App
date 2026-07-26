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
  // RESUMING RELEASES THE QUEUE. The pause branch of the guard parks messages
  // with a hold of its own; writing a "resumed" marker alone left those rows
  // sitting there ("Paused by you - sends in ~64 min") under a panel that said
  // "Agents active". Pull them forward onto a paced ladder so resume means what
  // it says. Best-effort: the drain re-checks every row against the guard.
  let released = 0;
  if (ok && mode === "resume") {
    const { releasePausedQueue } = await import("@/lib/wa/resume-queue");
    released = await releasePausedQueue(session.email).catch(() => 0);
  }
  return NextResponse.json({ ok, paused: mode === "pause", released });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json({ paused: (await isSessionPaused(session.email)) === true });
}
