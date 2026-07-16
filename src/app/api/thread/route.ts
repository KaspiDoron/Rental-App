import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Last exchange with one rental shop: the newest message WE sent it and the
// newest reply IT sent back - powers the sent/received peek on the card.
// Scoped to the signed-in user's own threads (thread context carries sender).
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const url = new URL(req.url);
  const vendorId = url.searchParams.get("vendorId") ?? "";
  if (!vendorId) return NextResponse.json({ error: "vendorId required" }, { status: 400 });

  // ATOMIC SESSION: only show this search's thread, never a previous session's
  // conversation with the same shop.
  const sinceMs = Number(url.searchParams.get("since") ?? 0);
  const since =
    sinceMs > 0 ? `&received_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}` : "";

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
    if (!sent?.to_number) return NextResponse.json({ messages: [] });
    const digits = sent.to_number;
    const [outs, ins] = await Promise.all([
      sbSelect<{ id: number; body: string; received_at: string; raw: { englishGloss?: string; kind?: string } | null }>(
        "whatsapp_messages",
        `select=id,body,received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
          digits
        )}&raw->>sender=eq.${encodeURIComponent(session.email)}${since}&order=received_at.asc&limit=60`
      ).catch(() => []),
      sbSelect<{ id: number; body: string; received_at: string; raw: { english?: string } | null }>(
        "whatsapp_messages",
        `select=id,body,received_at,raw&direction=eq.inbound&from_number=eq.${encodeURIComponent(
          digits
        )}${since}&order=received_at.asc&limit=60`
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
      })),
    ]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-80);
    return NextResponse.json({ messages });
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
      `select=body,received_at,raw&direction=eq.inbound&from_number=eq.${encodeURIComponent(
        sent.to_number
      )}${since}&order=received_at.desc&limit=1`
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
