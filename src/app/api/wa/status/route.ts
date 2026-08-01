import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  connectionState,
  evolutionConfigured,
  isLinkedForUi,
  touchActivity,
  markOpen,
} from "@/lib/evolution";
import { deriveConnectionPhase } from "@/lib/wa/connection-state";

// Current state of the user's personal WhatsApp session.
//
// A transient drop (Render sleeping/restarting) is NOT treated as "disconnected"
// - if the user has paired before, we report connected+reconnecting so the UI
// stays calm and the send path auto-resumes from saved credentials.
export const dynamic = "force-dynamic";

// How long the live-socket probe may hold the response. Past this we answer
// from the durable pairing record - which is the only thing the "is it linked?"
// gate actually needs - and let the probe finish in the background.
const SOCKET_PROBE_MS = 4_000;

// This answer changes the moment the traveller links or unlinks, and a stale
// "connected:false" replayed from a cache is indistinguishable from a real
// disconnection. Never cache it, anywhere.
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });

  const available = await evolutionConfigured();
  if (!available)
    return NextResponse.json({ available: false, connected: false }, { headers: NO_STORE });

  // PAIRING HOT PATH: while the connect screen polls every ~2s the user has no
  // outbox to drain, and firing two full drains per poll turned a cheap status
  // read into the most expensive request in the app right when latency matters
  // most. The client sets ?pairing=1 for those polls.
  const pairing = new URL(req.url).searchParams.get("pairing") === "1";

  // ANSWER FAST, EVEN WHEN EVOLUTION IS ASLEEP.
  //
  // connectionState probes the Evolution host TWICE (connectionState, then the
  // instance list), each bounded at 12s - so a cold Render host could hold this
  // response ~25s. That is what stranded the UI: the Profile pill sat on
  // "CHECKING..." and the Find-deals gate recorded the failed read as
  // "confirmed unlinked" and drew the blur lock over a linked account.
  //
  // The two questions have very different costs, so ask them in parallel and
  // bound the expensive one. `paired` is a Supabase read and answers in
  // milliseconds; it is also the ONLY input the "is this linked?" gate needs.
  // The socket probe merely refines live-vs-reconnecting, so when it is slow we
  // publish the durable answer instead of making the traveller wait for it.
  const socketProbe = connectionState(session.email).catch(() => null);
  const [storedPaired, state] = await Promise.all([
    isLinkedForUi(session.email).catch(() => false),
    Promise.race([
      socketProbe,
      new Promise<null>((r) => setTimeout(() => r(null), SOCKET_PROBE_MS)),
    ]),
  ]);
  // A late socket answer is still worth having: let it settle markOpen in the
  // background so the NEXT read is exact.
  void socketProbe;
  // "paired" = the user GENUINELY linked before (durable status "open"), not
  // merely "a session row exists" - a not-yet-linked "connecting" row must NOT
  // read as connected (that made first-time pairing report linked on the first
  // 3s poll and clear the code before the user entered it). isLinkedForUi still
  // fails SAFE on a DB blip, so a transient host outage reports
  // connected+reconnecting, never a hard "disconnected" that re-links a paired user.
  const paired = state === "open" ? true : storedPaired;

  // Persist "open" durably whenever we observe a live socket, so the send path
  // never later mistakes a transient drop for "never connected".
  if (state === "open") markOpen(session.email).catch(() => {});

  // App-activity heartbeat: the session stays "awake" only while the app is
  // actually being used; idle sessions are quieted by pauseIdleSessions.
  touchActivity(session.email).catch(() => {});

  // Opportunistic anti-ban outbox drain: the app polling status while open is
  // our free "worker tick" for business-hours / pacing-queued messages.
  if (!pairing) {
    try {
      const { drainOutbox } = await import("@/lib/wa-guard");
      const { sendFromUser } = await import("@/lib/evolution");
      // AWAITED, not fire-and-forget - the same Cloud Run truth the activity
      // route documents: CPU is throttled to ~0 once the response is flushed,
      // so a `void` drain here was suspended mid-send and the row it had just
      // claimed sat until something else picked it up. Bounded so a slow host
      // can never hold this poll open.
      //
      // fast=true - see the note on the ingest drain: the presence simulation
      // costs 4-12s per row and none of the anti-ban floors depend on it.
      const DRAIN_BUDGET_MS = 8_000;
      const bounded = <T,>(p: Promise<T>) =>
        Promise.race([p, new Promise((r) => setTimeout(r, DRAIN_BUDGET_MS))]);
      await bounded(
        drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text, true)).catch(
          () => {}
        )
      );
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      await bounded(
        drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text, true)).catch(
          () => {}
        )
      );
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json({
    available: true,
    state: state ?? "disconnected",
    // Linked from the user's perspective if live-open OR paired-and-reconnecting.
    connected: state === "open" || paired,
    live: state === "open",
    reconnecting: paired && state !== "open",
    // Server-side phase for callers with no credential context (e.g. the
    // Profile pill). The connect screen re-derives with the same pure function,
    // adding what only it knows: whether a code is on screen and its remaining
    // life. One definition, two levels of detail.
    phase: deriveConnectionPhase({ state, paired }),
  }, { headers: NO_STORE });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
