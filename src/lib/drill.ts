import "server-only";
import { sbSelect } from "./runtime-config";

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

// A drill/test rehearsal is a short interactive session - keep the window tight
// so a friend's private chatter is never ingested for long.
export const DRILL_INGEST_WINDOW_MS = 3 * 3600_000; // 3h (was 12h)
// A real shop thread stays ingestible while the negotiation is plausibly live,
// then retires. Generous enough for a slow shop, bounded enough that a
// long-dormant number can never silently re-open ingestion.
export const REAL_THREAD_INGEST_WINDOW_MS = 14 * 24 * 3600_000; // 14 days

interface OutRaw {
  drill?: boolean;
  test?: boolean;
  vendorId?: string;
  rfq?: unknown;
  kind?: string;
}

/** Does this outbound anchor a REAL rental-shop conversation (an RFQ/agent
 *  send), as opposed to a stray/human-manual message? */
function isRfqAnchor(raw: OutRaw | null): boolean {
  if (!raw) return false;
  if (raw.rfq != null) return true;
  const vid = String(raw.vendorId ?? "");
  if (vid && !vid.startsWith("drill-") && !vid.startsWith("test-")) return true;
  const kind = String(raw.kind ?? "");
  return ["rfq", "bargain", "auto", "auto-reply", "custom", "close", "consent"].includes(kind);
}

function isDrillAnchor(raw: OutRaw | null): boolean {
  if (!raw) return false;
  const vid = String(raw.vendorId ?? "");
  return raw.drill === true || raw.test === true || vid.startsWith("drill-") || vid.startsWith("test-");
}

export async function isVendorThread(fromDigits: string, ownerEmail: string): Promise<boolean> {
  // Look at the recent outbound history of THIS user to THIS number (not just
  // the single newest row: a human-manual reply could be newest while the
  // thread's real RFQ anchor is a few messages back).
  const rows = await sbSelect<{ received_at: string; raw: OutRaw | null }>(
    "whatsapp_messages",
    `select=received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&raw->>sender=eq.${encodeURIComponent(ownerEmail)}&order=received_at.desc&limit=10`
  );
  if (!rows.length) return false;
  const newest = rows[0];
  const newestAgeMs = Date.now() - Date.parse(newest.received_at);

  // Drill/test rehearsal: short window, measured from the most recent send.
  if (rows.some((r) => isDrillAnchor(r.raw))) {
    return newestAgeMs < DRILL_INGEST_WINDOW_MS;
  }

  // Real thread: require an RFQ anchor somewhere in the recent history AND that
  // the thread is still within the active-negotiation window.
  if (!rows.some((r) => isRfqAnchor(r.raw))) return false;
  return newestAgeMs < REAL_THREAD_INGEST_WINDOW_MS;
}
