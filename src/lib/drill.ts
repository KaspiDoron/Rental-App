import "server-only";
import { sbSelect } from "./runtime-config";

// The SINGLE ingestion-gate predicate for inbound WhatsApp, shared by the
// Evolution webhook AND the pull-based recovery sync (wa-sync). Having two
// copies is how the drill window got enforced on one path and silently
// skipped on the other - a drilled friend's PRIVATE chats kept being pulled
// in for hours after the drill ended.
//
// A number is an ingestible vendor thread for a user when THAT user's agent
// messaged it as a rental-shop thread. Drill/test threads (the owner
// rehearsing against a friend's real number) count for 12 HOURS only: when
// the drill is over, the friend's private messages stop being ingested on
// EVERY path.

export const DRILL_INGEST_WINDOW_MS = 12 * 3600_000;

export async function isVendorThread(fromDigits: string, ownerEmail: string): Promise<boolean> {
  const rows = await sbSelect<{
    received_at: string;
    raw: { drill?: boolean; vendorId?: string } | null;
  }>(
    "whatsapp_messages",
    `select=received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&raw->>sender=eq.${encodeURIComponent(ownerEmail)}&order=received_at.desc&limit=1`
  );
  const row = rows[0];
  if (!row) return false;
  const isDrill =
    row.raw?.drill === true || String(row.raw?.vendorId ?? "").startsWith("drill-");
  if (isDrill) {
    return Date.now() - Date.parse(row.received_at) < DRILL_INGEST_WINDOW_MS;
  }
  return true;
}
