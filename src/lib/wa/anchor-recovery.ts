// SELF-HEALING RFQ ANCHOR.
//
// The failure this exists for: a shop replies, the ingest gate says "yes, this
// is a live thread we messaged", and then the agent drops the reply anyway with
// `no-rfq-thread` because no outbound row in the window carries `raw.rfq`. The
// conversation is then dead forever - every later reply hits the same wall -
// even though the traveller obviously HAS an active search for that vehicle.
//
// Any write path that stores an outbound row without the rfq (a takeover row, a
// legacy row, a send whose caller omitted it, a schema-less retry) produces
// that state permanently. Rather than add a fourth predicate, we RECOVER: the
// user's own most recent search already holds the RFQ that produced this
// outreach, so we re-anchor from it and repair the row.
//
// Safety rules, deliberately strict - a recovered anchor must never invent a
// negotiation that the traveller did not ask for:
//   1. Only ever runs when we ALREADY messaged this number (anchors > 0) and
//      the ingest gate passed. No outreach => no recovery, the reply is dropped
//      exactly as before.
//   2. The search must be recent (MAX_AGE_MS) - a months-old search must not
//      resurrect a dead thread.
//   3. The RFQ must be structurally usable, or we do not guess.

// NOTE: deliberately NOT `server-only`, and the DB layer is imported lazily
// below - the selection rules above it are pure and must stay unit-testable.
import type { StructuredRFQ } from "../types";

/** A search row can only re-anchor a thread this fresh. */
export const RECOVERY_MAX_AGE_MS = 14 * 24 * 3600_000;

export interface SearchRfqRow {
  created_at: string;
  rfq: unknown;
}

/**
 * Is this blob a usable RFQ? The engine needs at minimum a duration to reason
 * about (every leverage line is per-day x days) and a vehicle class to keep the
 * conversation on-spec. Anything less and we would be inventing the request.
 */
export function isUsableRfq(v: unknown): v is StructuredRFQ {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.durationDays === "number" && r.durationDays > 0 && typeof r.vehicleClass === "string";
}

/**
 * Pick the RFQ to re-anchor with: the NEWEST usable search inside the window.
 * Pure, so the selection rules are unit-tested rather than inferred from logs.
 */
export function pickRecoveryRfq(
  rows: SearchRfqRow[],
  nowMs: number,
  maxAgeMs: number = RECOVERY_MAX_AGE_MS
): StructuredRFQ | null {
  let best: { at: number; rfq: StructuredRFQ } | null = null;
  for (const r of rows) {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at)) continue;
    if (nowMs - at > maxAgeMs) continue;
    if (at > nowMs + 60_000) continue; // clock skew guard - no future rows
    if (!isUsableRfq(r.rfq)) continue;
    if (!best || at > best.at) best = { at, rfq: r.rfq };
  }
  return best?.rfq ?? null;
}

/**
 * Read this user's recent searches and return the newest usable RFQ.
 * Returns null (never throws) when the column/table is unavailable, so a
 * pre-migration deployment simply behaves as it does today.
 */
export async function recoverRfqForSender(
  senderEmail: string,
  nowMs: number = Date.now()
): Promise<StructuredRFQ | null> {
  if (!senderEmail) return null;
  const { sbSelect } = await import("../runtime-config");
  const since = new Date(nowMs - RECOVERY_MAX_AGE_MS).toISOString();
  const rows = await sbSelect<SearchRfqRow>(
    "searches",
    `select=created_at,rfq&user_email=eq.${encodeURIComponent(
      senderEmail
    )}&rfq=not.is.null&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=10`
  ).catch(() => [] as SearchRfqRow[]);
  return pickRecoveryRfq(rows, nowMs);
}
