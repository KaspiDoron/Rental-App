import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  connectionState,
  evolutionConfigured,
  isLinkedForUi,
  touchActivity,
  markOpen,
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
  // "paired" = the user GENUINELY linked before (durable status "open"), not
  // merely "a session row exists" - a not-yet-linked "connecting" row must NOT
  // read as connected (that made first-time pairing report linked on the first
  // 3s poll and clear the code before the user entered it). isLinkedForUi still
  // fails SAFE on a DB blip, so a transient host outage reports
  // connected+reconnecting, never a hard "disconnected" that re-links a paired user.
  const paired = state === "open" ? true : await isLinkedForUi(session.email);

  // Persist "open" durably whenever we observe a live socket, so the send path
  // never later mistakes a transient drop for "never connected".
  if (state === "open") markOpen(session.email).catch(() => {});

  // App-activity heartbeat: the session stays "awake" only while the app is
  // actually being used; idle sessions are quieted by pauseIdleSessions.
  touchActivity(session.email).catch(() => {});

  // Opportunistic anti-ban outbox drain: the app polling status while open is
  // our free "worker tick" for business-hours / pacing-queued messages.
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text)).catch(
      () => {}
    );
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text)).catch(
      () => {}
    );
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    available: true,
    state: state ?? "disconnected",
    // Linked from the user's perspective if live-open OR paired-and-reconnecting.
    connected: state === "open" || paired,
    live: state === "open",
    reconnecting: paired && state !== "open",
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
