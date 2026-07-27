import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sessionPauseState, setSessionPaused } from "@/lib/session-flags";

// Pause / resume the whole search session ("Will, hold everything"). Paused:
// replies keep landing and are stored, but the agents send nothing - enforced
// server-side in the reply loop AND the outbound guard, not just in the UI.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === "pause" ? "pause" : body.mode === "resume" ? "resume" : null;
  if (!mode) return NextResponse.json({ error: "mode must be 'pause' or 'resume'" }, { status: 400 });
  const { ok, version } = await setSessionPaused(session.email, mode === "pause");
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
  // The version travels with the answer. It is what lets the client refuse a
  // later poll that was answered from another instance's pre-write cache - the
  // "resume flickers back to paused" bug (see lib/versioned).
  return NextResponse.json({ ok, paused: mode === "pause", released, version });
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  // The caller tells us the newest version it has seen; a cached value older
  // than that is refused and re-read rather than served.
  const known = Number(new URL(req.url).searchParams.get("known") ?? 0);
  const state = await sessionPauseState(session.email, Number.isFinite(known) ? known : 0);
  return NextResponse.json({ paused: state.paused === true, version: state.version });
}
