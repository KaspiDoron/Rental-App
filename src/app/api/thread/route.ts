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

  const outbound = await sbSelect<{ body: string; received_at: string; to_number: string; raw: { englishGloss?: string } | null }>(
    "whatsapp_messages",
    `select=body,received_at,to_number,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      session.email
    )}&raw->>vendorId=eq.${encodeURIComponent(vendorId)}&order=received_at.desc&limit=1`
  );
  const sent = outbound[0] ?? null;

  let received: { body: string; received_at: string } | null = null;
  if (sent?.to_number) {
    const inbound = await sbSelect<{ body: string; received_at: string }>(
      "whatsapp_messages",
      `select=body,received_at&direction=eq.inbound&from_number=eq.${encodeURIComponent(
        sent.to_number
      )}&order=received_at.desc&limit=1`
    );
    received = inbound[0] ?? null;
  }

  return NextResponse.json({
    sent: sent
      ? { text: sent.body, at: sent.received_at, english: sent.raw?.englishGloss }
      : null,
    received: received ? { text: received.body, at: received.received_at } : null,
  });
}
