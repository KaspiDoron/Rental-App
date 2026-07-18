import "server-only";
import { sbSelect } from "./runtime-config";
import { classifyIngest, DRILL_INGEST_WINDOW_MS, REAL_THREAD_INGEST_WINDOW_MS, type GateRaw } from "./wa/thread-gate";

export { DRILL_INGEST_WINDOW_MS, REAL_THREAD_INGEST_WINDOW_MS };

// The SINGLE ingestion-gate predicate for inbound WhatsApp, shared by the
// Evolution webhook AND the pull-based recovery sync (wa-sync). Having two
// copies is how the drill window got enforced on one path and silently
// skipped on the other - a drilled friend's PRIVATE chats kept being pulled
// in for hours after the drill ended.
//
// A number is an ingestible thread for a user ONLY when THAT user's agent
// opened a real rental-shop conversation with it (an RFQ/agent send), and only
// while that conversation is still ACTIVE. Three hard rules make this hermetic:
//   1. RFQ ANCHOR: "ever sent them anything" is NOT enough - a mistyped number,
//      a stray custom message or a human-manual reply must not turn a personal
//      contact into a permanent ingestion target. There must be an rfq/agent
//      outbound in the thread.
//   2. RECENCY: even a real shop thread retires - inbound stops being ingested
//      once the negotiation window lapses, so a number messaged weeks ago can
//      never quietly re-open ingestion.
//   3. DRILL/TEST WINDOW: the owner rehearsing against a friend's REAL number
//      (Live Drill, or an anti-spoof test re-key) ingests for a SHORT window
//      only; when the rehearsal is over, the friend's private messages stop
//      being ingested on EVERY path.

export async function isVendorThread(fromDigits: string, ownerEmail: string): Promise<boolean> {
  // Look at the recent outbound history of THIS user to THIS number (not just
  // the single newest row: a human-manual reply could be newest while the
  // thread's real RFQ anchor is a few messages back). The pure gate logic lives
  // in wa/thread-gate.ts (unit-tested).
  const rows = await sbSelect<{ received_at: string; raw: GateRaw | null }>(
    "whatsapp_messages",
    `select=received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&raw->>sender=eq.${encodeURIComponent(ownerEmail)}&order=received_at.desc&limit=10`
  );
  return classifyIngest(rows, Date.now());
}
