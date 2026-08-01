// ONE READ FOR THE WHOLE BOARD.
//
// Every engaged card mounts a ThreadPeek, and every peek ran its own 10-second
// poll against `/api/thread?vendorId=...`. Twenty engaged shops was twenty
// HTTP requests every ten seconds, and each of those requests ran two or three
// sequential Supabase reads - sixty round trips a tick, on a phone, for a
// two-line preview. It is the textbook N+1, moved to the network.
//
// The shape is wrong rather than slow: the answer for twenty shops is the same
// two queries as the answer for one. The newest outbound row per shop comes out
// of ONE descending read grouped in memory; the newest inbound reply comes out
// of ONE more, joined on the shop's line rather than on a raw number string.
//
// The grouping lives here, pure, so the join can be tested rather than trusted
// - keying a Map on a `from_number` and looking it up with a `to_number` is the
// same bug `identityKey` exists to prevent, and it fails SILENTLY (an empty
// peek looks exactly like a shop that has not replied yet).

import { identityKey } from "../wa/phone-key";

/**
 * How many shops one batch may cover. A hunt is 40 shops at the widest radius,
 * and only engaged ones mount a peek at all, so this is a ceiling rather than a
 * working limit - it exists so a crafted query cannot ask for thousands.
 */
export const MAX_PEEK_VENDORS = 40;

/**
 * How many recent messages each side's single read pulls back.
 *
 * The read is already scoped to ONE traveller and ONE search session (`since`),
 * so this covers every message of a normal hunt several times over. The honest
 * failure mode when it is not enough: a very chatty shop pushes a quieter one's
 * newest row out of the window, and that shop's peek simply does not update
 * this tick. It never shows another shop's message - the join is by line - and
 * the card's own offer row is unaffected.
 */
export const PEEK_ROW_LIMIT = 300;

export interface PeekOutRow {
  body: string;
  received_at: string;
  to_number: string;
  raw: { vendorId?: string; englishGloss?: string } | null;
}

export interface PeekInRow {
  body: string;
  received_at: string;
  from_number: string;
  raw: { english?: string } | null;
}

export interface PeekQueuedRow {
  body: string;
  not_before: string;
  meta: { vendorId?: string; englishGloss?: string } | null;
}

export interface PeekMsg {
  text: string;
  at?: string;
  english?: string;
  queued?: boolean;
}

export interface Peek {
  sent: PeekMsg | null;
  received: PeekMsg | null;
}

/**
 * The vendor ids that may be interpolated into a PostgREST `in.(...)` list.
 *
 * The batch parameter is user input reaching a query string, so it is filtered
 * to the alphabet real vendor ids use (Google place ids and our own synthetic
 * ones) rather than escaped - anything that could carry a comma, a quote or a
 * parenthesis is dropped, not quoted, because there is no legitimate id that
 * needs one.
 */
export function safeVendorIds(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const id = part.trim();
    if (!id || id.length > 128) continue;
    if (!/^[A-Za-z0-9_:.-]+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_PEEK_VENDORS) break;
  }
  return out;
}

/**
 * The FIRST row per vendor, in whatever order the caller read them.
 *
 * Delivered rows arrive newest-first (so first = newest); queued rows arrive
 * due-first (so first = the one that goes out next). Both are "the row this
 * card should show", which is why one grouping serves both.
 */
export function firstByVendor<T>(rows: T[], vendorIdOf: (row: T) => string | undefined): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = vendorIdOf(row);
    if (!id || out.has(id)) continue;
    out.set(id, row);
  }
  return out;
}

/**
 * The newest inbound reply per SHOP LINE, keyed so an outbound row's
 * `to_number` can find it.
 *
 * WhatsApp writes the number it delivered from and discovery wrote the number
 * it found; those two spellings of one shop are routinely different, so the key
 * is the national tail, not the string.
 */
export function newestInboundByLine(rows: PeekInRow[]): Map<string, PeekInRow> {
  const out = new Map<string, PeekInRow>();
  for (const row of rows) {
    const key = identityKey(row.from_number);
    if (!key || out.has(key)) continue;
    out.set(key, row);
  }
  return out;
}

/**
 * The per-card answer, for every requested shop.
 *
 * A shop with nothing at all still gets an entry: the client needs to be able
 * to tell "no thread yet" from "this tick did not cover you".
 */
export function buildPeeks(
  ids: string[],
  outs: PeekOutRow[],
  ins: PeekInRow[],
  queued: PeekQueuedRow[]
): Record<string, Peek> {
  const sentBy = firstByVendor(outs, (r) => r.raw?.vendorId);
  const queuedBy = firstByVendor(queued, (r) => r.meta?.vendorId);
  const inboundBy = newestInboundByLine(ins);

  const peeks: Record<string, Peek> = {};
  for (const id of ids) {
    const sent = sentBy.get(id);
    // Nothing delivered yet? Show the QUEUED body - the exact text that WILL go
    // out - flagged as queued. The card never shows a client-side draft and
    // never claims "sent" for a held message.
    const held = sent ? undefined : queuedBy.get(id);
    const line = sent ? identityKey(sent.to_number) : "";
    const reply = line ? inboundBy.get(line) : undefined;
    peeks[id] = {
      sent: sent
        ? { text: sent.body, at: sent.received_at, english: sent.raw?.englishGloss }
        : held
          ? { text: held.body, at: held.not_before, english: held.meta?.englishGloss, queued: true }
          : null,
      received: reply
        ? { text: reply.body, at: reply.received_at, english: reply.raw?.english }
        : null,
    };
  }
  return peeks;
}
