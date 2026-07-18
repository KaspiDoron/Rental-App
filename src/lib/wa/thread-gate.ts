// Pure predicates for the inbound-ingestion gate (no server-only, no DB) so the
// isolation rules are unit-testable in isolation. drill.ts wraps these with the
// actual whatsapp_messages read.

// A drill/test rehearsal is a short interactive session - keep the window tight
// so a friend's private chatter is never ingested for long.
export const DRILL_INGEST_WINDOW_MS = 3 * 3600_000; // 3h
// A real shop thread stays ingestible while the negotiation is plausibly live,
// then retires - so a number messaged weeks ago can never re-open ingestion.
export const REAL_THREAD_INGEST_WINDOW_MS = 14 * 24 * 3600_000; // 14 days

export interface GateRaw {
  drill?: boolean;
  test?: boolean;
  vendorId?: string;
  rfq?: unknown;
  kind?: string;
}

/** Does this outbound anchor a REAL rental-shop conversation (an RFQ/agent
 *  send), as opposed to a stray/human-manual/personal message? */
export function isRfqAnchor(raw: GateRaw | null | undefined): boolean {
  if (!raw) return false;
  if (raw.rfq != null) return true;
  const vid = String(raw.vendorId ?? "");
  if (vid && !vid.startsWith("drill-") && !vid.startsWith("test-")) return true;
  const kind = String(raw.kind ?? "");
  return ["rfq", "bargain", "auto", "auto-reply", "custom", "close", "consent"].includes(kind);
}

/** Is this a drill/test rehearsal thread (owner testing against a real number)? */
export function isDrillAnchor(raw: GateRaw | null | undefined): boolean {
  if (!raw) return false;
  const vid = String(raw.vendorId ?? "");
  return (
    raw.drill === true ||
    raw.test === true ||
    vid.startsWith("drill-") ||
    vid.startsWith("test-")
  );
}

/**
 * Given this user's recent outbound rows to a number (newest-first), decide
 * whether inbound from that number is ingestible RIGHT NOW. Three rules:
 *   - drill/test rehearsal -> short window from the most recent send
 *   - real thread -> requires an RFQ anchor AND is within the active window
 *   - anything else (only stray/human-manual outbounds, or too old) -> no
 */
export function classifyIngest(
  rows: { received_at: string; raw: GateRaw | null }[],
  nowMs: number
): boolean {
  if (!rows.length) return false;
  const newestAge = nowMs - Date.parse(rows[0].received_at);
  if (!Number.isFinite(newestAge)) return false;
  if (rows.some((r) => isDrillAnchor(r.raw))) return newestAge < DRILL_INGEST_WINDOW_MS;
  if (!rows.some((r) => isRfqAnchor(r.raw))) return false;
  return newestAge < REAL_THREAD_INGEST_WINDOW_MS;
}
