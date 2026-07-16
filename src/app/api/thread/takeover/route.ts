import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { isThreadTakenOver, setThreadTakeover } from "@/lib/session-flags";

// Human takeover controls for one shop thread. Takeover also happens
// automatically when the user types in the WhatsApp thread (webhook
// detection); this route is the in-app switch + status read.

async function digitsForVendor(email: string, vendorId: string): Promise<string | null> {
  const rows = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      email
    )}&raw->>vendorId=eq.${encodeURIComponent(vendorId)}&order=received_at.desc&limit=1`
  ).catch(() => []);
  return rows[0]?.to_number ?? null;
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const url = new URL(req.url);
  const vendorId = url.searchParams.get("vendorId") ?? "";
  if (!vendorId) return NextResponse.json({ error: "vendorId required" }, { status: 400 });
  const digits = await digitsForVendor(session.email, vendorId);
  if (!digits) return NextResponse.json({ takeover: false });
  return NextResponse.json({ takeover: await isThreadTakenOver(session.email, digits) });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const vendorId = String(body.vendorId ?? "");
  const mode = body.mode === "takeover" ? true : body.mode === "handback" ? false : null;
  if (!vendorId || mode === null) {
    return NextResponse.json({ error: "vendorId and mode (takeover|handback) required" }, { status: 400 });
  }
  const digits = await digitsForVendor(session.email, vendorId);
  if (!digits) return NextResponse.json({ error: "no thread with this shop yet" }, { status: 404 });
  const ok = await setThreadTakeover(session.email, digits, mode);
  return NextResponse.json({ ok, takeover: mode });
}
