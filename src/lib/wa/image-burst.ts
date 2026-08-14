import "server-only";
import { sbSelect } from "../runtime-config";
import { numberFilter } from "./phone-key";

// FIVE PHOTOS ARE ONE MESSAGE.
//
// A shop answering "what do you have?" sends an album: five frames, five
// webhooks, milliseconds apart. The worker pipeline coalesces them in a Redis
// window - and the worker is deployed nowhere, so in production every frame ran
// its own turn, each seeing ONE FIFTH of the price board and composing its own
// reply. The traveller watched the agent answer a five-photo album five times.
//
// This is the coalescer for the runtime that actually runs. No Redis, no
// worker: the frames are already stored in whatsapp_messages by the time the
// turn starts (ingest stores before it processes), so the database IS the
// buffer. The protocol:
//
//   NEWEST FRAME WINS. Every image turn asks "am I the newest frame of this
//   burst?" A frame with a newer sibling stands down - the sibling's own
//   invocation (which asked the same question later) owns the whole burst.
//   The newest frame can never stand down, so exactly the last arrival runs
//   the turn, with every frame of the burst attached.
//
//   DEFER ONCE, ON BURSTS ONLY. A multi-frame burst whose newest frame is
//   seconds old is very likely still landing (album frames arrive over a few
//   seconds, and webhooks can arrive out of order) - so the would-be
//   processor waits ONCE (~4s), re-asks, and either stands down (a straggler
//   arrived: its invocation owns the fuller burst) or proceeds with
//   everything that landed. A LONE photo never pays the wait: one extra
//   database read and straight on with the turn.
//
// Races lose gracefully: two frames that both believe they are newest each run
// a turn, and the stale-draft freshness gate drops the older reply at send
// time - the exact behaviour the drain already has for any superseded draft.

const BURST_WINDOW_MS = 6_000;
const DEFER_MS = 4_000;
const MAX_BURST_ROWS = 16;

interface SiblingRow {
  id: number;
  wa_message_id: string | null;
  received_at: string;
  type: string;
  raw: {
    media?: { key?: unknown; kind?: string; mime?: string | null };
  } | null;
}

function isImageRow(r: SiblingRow): boolean {
  const m = r.raw?.media;
  if (!m) return false;
  if (m.kind === "image") return true;
  return Boolean(m.mime && /^image\//i.test(m.mime));
}

async function siblingFrames(email: string, fromDigits: string): Promise<SiblingRow[]> {
  const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
  const rows = await sbSelect<SiblingRow>(
    "whatsapp_messages",
    `select=id,wa_message_id,received_at,type,raw&direction=eq.inbound` +
      `&raw->>receiver=eq.${encodeURIComponent(email)}` +
      `&received_at=gte.${encodeURIComponent(since)}` +
      `&type=in.(image,document)` +
      `&order=id.asc&limit=${MAX_BURST_ROWS}${numberFilter("from_number", fromDigits)}`
  ).catch(() => [] as SiblingRow[]);
  return rows.filter(isImageRow);
}

/** Is there a frame NEWER than ours? Pure, so the protocol is unit-testable. */
export function newerSibling(
  rows: Array<{ id: number; wa_message_id: string | null }>,
  ownMsgId: string
): { id: number; wa_message_id: string | null } | null {
  const own = rows.find((r) => r.wa_message_id === ownMsgId);
  if (!own) return null; // our row is not visible - never stand down blind
  const newest = rows[rows.length - 1];
  return newest && newest.id > own.id ? newest : null;
}

export type BurstVerdict =
  | { standDown: true; leaderId: string }
  | {
      standDown: false;
      /** Every burst frame in arrival order, own frame included. */
      frames: Array<{ mime: string; base64: string; waMessageId: string }>;
      /** Sibling frames whose bytes could not be fetched (traced by caller). */
      fetchFailures: number;
      /** How many frames the burst held in total (before any fetch failure). */
      burstSize: number;
      /** True when this frame's own bytes could not be fetched. */
      ownFetchFailed: boolean;
    };

/**
 * Assemble the burst this frame belongs to, or stand down to a newer sibling.
 *
 * Injection points (`fetchOwn`/`fetchByKey`/`sleep`) exist so the protocol is
 * testable without Evolution or a database in the loop.
 */
export async function assembleImageBurst(opts: {
  email: string;
  fromDigits: string;
  ownMsgId: string;
  fetchOwn: () => Promise<{ mime: string; base64: string } | null>;
  fetchByKey: (key: unknown) => Promise<{ mime: string; base64: string } | null>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BurstVerdict> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 1) Who else is in this burst right now?
  let rows = await siblingFrames(opts.email, opts.fromDigits);
  const newer0 = newerSibling(rows, opts.ownMsgId);
  if (newer0) return { standDown: true, leaderId: newer0.wa_message_id ?? String(newer0.id) };

  // 2) Fetch our own bytes (the slow part - the album may still be uploading).
  const own = await opts.fetchOwn();

  // 3) Re-ask. A lone photo pays exactly this one extra read and moves on.
  //    (Anything that arrived during the fetch is NEWER than us - store ids
  //    are monotonic - so growth always resolves to a stand-down here.)
  rows = await siblingFrames(opts.email, opts.fromDigits);
  const newer1 = newerSibling(rows, opts.ownMsgId);
  if (newer1) return { standDown: true, leaderId: newer1.wa_message_id ?? String(newer1.id) };

  // 4) We hold the newest frame of a MULTI-frame burst: a straggler may still
  //    be in flight (out-of-order webhooks). Wait once, re-ask, and hand over
  //    to any frame that landed meanwhile - otherwise this is the whole burst.
  if (rows.length >= 2) {
    await sleep(DEFER_MS);
    rows = await siblingFrames(opts.email, opts.fromDigits);
    const newer2 = newerSibling(rows, opts.ownMsgId);
    if (newer2) return { standDown: true, leaderId: newer2.wa_message_id ?? String(newer2.id) };
  }

  // 4) We are the newest frame: assemble every sibling's bytes, arrival order.
  const frames: Array<{ mime: string; base64: string; waMessageId: string }> = [];
  let fetchFailures = 0;
  for (const r of rows) {
    const msgId = r.wa_message_id ?? String(r.id);
    if (msgId === opts.ownMsgId) {
      if (own) frames.push({ ...own, waMessageId: msgId });
      continue;
    }
    const key = r.raw?.media?.key;
    if (!key) {
      fetchFailures++;
      continue;
    }
    const media = await opts.fetchByKey(key).catch(() => null);
    if (media) frames.push({ ...media, waMessageId: msgId });
    else fetchFailures++;
  }
  return {
    standDown: false,
    frames,
    fetchFailures,
    burstSize: rows.length || 1,
    ownFetchFailed: !own,
  };
}
