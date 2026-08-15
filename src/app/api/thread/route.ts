import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { numberFilter } from "@/lib/wa/phone-key";
import {
  buildPeeks,
  safeVendorIds,
  PEEK_ROW_LIMIT,
  type PeekOutRow,
  type PeekInRow,
  type PeekQueuedRow,
} from "@/lib/thread/peek-batch";

// A live transcript poll: it must never be statically cached or the ThreadDashboard
// freezes on its first snapshot (the "app out of sync with WhatsApp" report).
export const dynamic = "force-dynamic";

// Last exchange with one rental shop: the newest message WE sent it and the
// newest reply IT sent back - powers the sent/received peek on the card.
// Scoped to the signed-in user's own threads (thread context carries sender).
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const url = new URL(req.url);
  const vendorId = url.searchParams.get("vendorId") ?? "";
  const vendorIds = url.searchParams.get("vendorIds") ?? "";
  if (!vendorId && !vendorIds)
    return NextResponse.json({ error: "vendorId required" }, { status: 400 });

  // ATOMIC SESSION: only show this search's thread, never a previous session's
  // conversation with the same shop.
  const sinceMs = Number(url.searchParams.get("since") ?? 0);
  const since =
    sinceMs > 0 ? `&received_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}` : "";

  // BATCH MODE: every mounted card's peek in one request.
  //
  // Each card used to poll this route for itself, so twenty engaged shops was
  // twenty requests every ten seconds and sixty Supabase reads a tick - for a
  // two-line preview, on a phone. The answer for twenty shops is the same two
  // reads as the answer for one; only the grouping differs.
  if (vendorIds) return batchPeek(session.email, vendorIds, since);

  const outbound = await sbSelect<{ body: string; received_at: string; to_number: string; raw: { englishGloss?: string } | null }>(
    "whatsapp_messages",
    `select=body,received_at,to_number,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      session.email
    )}&raw->>vendorId=eq.${encodeURIComponent(vendorId)}${since}&order=received_at.desc&limit=1`
  );
  const sent = outbound[0] ?? null;

  // FULL transcript mode (?full=1): every message both ways for this thread,
  // oldest first - powers the TranscriptSheet chat view. The default 2-message
  // shape below stays untouched (ThreadPeek relies on it).
  if (url.searchParams.get("full") === "1") {
    // NO OUTBOUND ROW IS NOT AN EMPTY CONVERSATION - it is "we have not written
    // to this shop yet", and the transcript sheet has to be able to tell the
    // difference between that, a thread with nothing in it, and a read that
    // failed. All three used to be the same `{messages: [], delivery: null}`.
    if (!sent?.to_number)
      return NextResponse.json({
        messages: [],
        delivery: null,
        state: "not-started",
        note: "Your agent has not messaged this shop yet.",
      });
    const digits = sent.to_number;
    const [outs, ins, recip] = await Promise.all([
      sbSelect<{ id: number; body: string; received_at: string; raw: { englishGloss?: string; kind?: string } | null }>(
        "whatsapp_messages",
        // Number matching is TOLERANT on every side of the transcript: outbound
        // rows carry the spelling discovery produced, inbound rows the one
        // WhatsApp delivered, and an exact match between the two silently
        // emptied half of the conversation.
        `select=id,body,received_at,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
          session.email
        )}${since}&order=received_at.asc&limit=60${numberFilter("to_number", digits)}`
      ).catch(() => []),
      sbSelect<{
        id: number;
        body: string;
        received_at: string;
        type: string | null;
        wa_message_id: string | null;
        raw: {
          english?: string;
          media?: { kind?: string; fileName?: string | null };
          location?: { lat: number; lng: number; name?: string | null };
          reading?: import("@/lib/media/reading").MediaReading;
          contact?: { name?: string | null; digits?: string | null };
        } | null;
      }>(
        "whatsapp_messages",
        // PRIVACY: inbound is scoped to the messages THIS user's WhatsApp
        // received (raw.receiver) - digits alone would leak another user's
        // thread with the same number.
        `select=id,body,received_at,type,wa_message_id,raw&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
          session.email
        )}${since}&order=received_at.asc&limit=60${numberFilter("from_number", digits)}`
      ).catch(() => []),
      // Delivery status for THIS user's number -> this shop (WhatsApp ticks:
      // sent -> delivered (double grey) -> read (blue) -> replied). Scoped by
      // sender_key so it is never another user's recipient row.
      sbSelect<{
        delivered: boolean;
        read: boolean;
        blocked: boolean;
        last_read_at: string | null;
        last_reply_at: string | null;
        last_sent_at: string | null;
      }>(
        "wa_recipient_state",
        `select=delivered,read,blocked,last_read_at,last_reply_at,last_sent_at&sender_key=eq.${encodeURIComponent(
          session.email
        )}&limit=1${numberFilter("to_number", digits)}`
      ).catch(() => []),
    ]);
    const messages = [
      ...outs.map((m) => ({
        id: `o${m.id}`,
        dir: "out" as const,
        text: m.body,
        english: m.raw?.englishGloss,
        kind: m.raw?.kind,
        at: m.received_at,
      })),
      ...ins.map((m) => ({
        id: `i${m.id}`,
        dir: "in" as const,
        text: m.body,
        // English gloss of a local-language shop reply (stamped async by the
        // agent loop) - the traveller always understands the conversation.
        english: m.raw?.english,
        at: m.received_at,
        // What the shop actually sent. A price board renders as the photo it
        // is, a dropped pin as a tappable map link - not as "[photo]".
        media:
          m.raw?.media && m.wa_message_id
            ? {
                id: m.wa_message_id,
                kind: (m.raw.media.kind ?? m.type ?? "image") as string,
                fileName: m.raw.media.fileName ?? null,
              }
            : undefined,
        location: m.raw?.location,
        contact: m.raw?.contact,
        // WHAT THE AGENTS READ IN IT. Stamped by the reply loop onto the very
        // message the media arrived on (lib/media/reading), so the transcript
        // can prove the understanding instead of asserting it.
        reading: m.raw?.reading,
      })),
    ]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-80);
    const rs = recip[0];
    const replied = ins.length > 0;
    const delivery = rs
      ? {
          sent: Boolean(rs.last_sent_at) || outs.length > 0,
          delivered: Boolean(rs.delivered),
          read: Boolean(rs.read),
          blocked: Boolean(rs.blocked),
          replied,
          lastReadAt: rs.last_read_at,
          lastReplyAt: rs.last_reply_at,
        }
      : {
          sent: outs.length > 0,
          delivered: false,
          read: false,
          blocked: false,
          replied,
          lastReadAt: null,
          lastReplyAt: null,
        };
    return NextResponse.json({ messages, delivery, state: "ok" });
  }

  let received: { body: string; received_at: string; raw?: { english?: string } | null } | null =
    null;
  if (sent?.to_number) {
    const inbound = await sbSelect<{
      body: string;
      received_at: string;
      raw: { english?: string } | null;
    }>(
      "whatsapp_messages",
      // PRIVACY: receiver-scoped - see the full-transcript query above.
      `select=body,received_at,raw&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        session.email
      )}${since}&order=received_at.desc&limit=1${numberFilter("from_number", sent.to_number)}`
    );
    received = inbound[0] ?? null;
  }

  // Nothing delivered yet? Surface the QUEUED outbox body (the exact text
  // that WILL go out) flagged as queued - the card never shows a client
  // draft, and never claims "sent" for a held message.
  let queued: { text: string; at: string; english?: string } | null = null;
  if (!sent) {
    const rows = await sbSelect<{
      body: string;
      not_before: string;
      meta: { vendorId?: string; englishGloss?: string } | null;
    }>(
      "wa_outbox",
      `select=body,not_before,meta&sender_key=eq.${encodeURIComponent(
        session.email
      )}&meta->>vendorId=eq.${encodeURIComponent(vendorId)}&order=not_before.asc&limit=1`
    ).catch(() => []);
    const q = rows[0];
    if (q) queued = { text: q.body, at: q.not_before, english: q.meta?.englishGloss };
  }

  return NextResponse.json({
    sent: sent
      ? { text: sent.body, at: sent.received_at, english: sent.raw?.englishGloss }
      : queued
        ? { ...queued, queued: true }
        : null,
    received: received
      ? { text: received.body, at: received.received_at, english: received.raw?.english }
      : null,
  });
}

/**
 * Every requested card's peek, in two reads (three when something is still
 * queued) regardless of how many shops are on the board.
 *
 * PRIVACY is unchanged and non-negotiable: outbound rows are scoped by
 * `raw.sender` and inbound rows by `raw.receiver`, exactly as the single-vendor
 * path does. Batching changes how many queries run, never whose messages they
 * can see - a shared number cannot pull another traveller's thread into this
 * payload because neither read is keyed on the number alone.
 */
async function batchPeek(email: string, raw: string, since: string) {
  const ids = safeVendorIds(raw);
  if (ids.length === 0) return NextResponse.json({ peeks: {} });

  const who = encodeURIComponent(email);
  const inList = `in.(${ids.map((id) => `"${id}"`).join(",")})`;

  const [outs, ins] = await Promise.all([
    sbSelect<PeekOutRow>(
      "whatsapp_messages",
      `select=body,received_at,to_number,raw&direction=eq.outbound&raw->>sender=eq.${who}&raw->>vendorId=${encodeURIComponent(
        inList
      )}${since}&order=received_at.desc&limit=${PEEK_ROW_LIMIT}`
    ).catch(() => [] as PeekOutRow[]),
    // The inbound side cannot filter by vendorId (WhatsApp does not know our
    // ids), so it reads this traveller's recent replies and the join happens in
    // memory on the shop's LINE - see newestInboundByLine.
    sbSelect<PeekInRow>(
      "whatsapp_messages",
      `select=body,received_at,from_number,raw&direction=eq.inbound&raw->>receiver=eq.${who}${since}&order=received_at.desc&limit=${PEEK_ROW_LIMIT}`
    ).catch(() => [] as PeekInRow[]),
  ]);

  // The queued read is SKIPPED entirely once every card has a delivered
  // message, which is the steady state of a running hunt.
  const delivered = new Set(outs.map((r) => r.raw?.vendorId).filter(Boolean) as string[]);
  const waiting = ids.filter((id) => !delivered.has(id));
  const queued = waiting.length
    ? await sbSelect<PeekQueuedRow>(
        "wa_outbox",
        `select=body,not_before,meta&sender_key=eq.${who}&meta->>vendorId=${encodeURIComponent(
          `in.(${waiting.map((id) => `"${id}"`).join(",")})`
        )}&order=not_before.asc&limit=${PEEK_ROW_LIMIT}`
      ).catch(() => [] as PeekQueuedRow[])
    : [];

  return NextResponse.json({ peeks: buildPeeks(ids, outs, ins, queued) });
}
