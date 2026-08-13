import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { messagePath } from "@/lib/wa/message-path";

// Ops Center: THE WHOLE PATH OF A MESSAGE (owner report 3, items 4+8).
//
// One chronological trail per (traveller, shop): stored messages with voice
// transcripts, current queue state, the append-only hold/attempt/drop trail,
// and armed wakeups. Plain JSON on purpose - the same endpoint feeds the Ops
// panel and any investigating tool, so the owner and the machine read the
// SAME truth and neither needs an LLM call to get it.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const senderKey = (params.get("sender") ?? "").trim().toLowerCase();
  const to = (params.get("to") ?? "").trim();
  if (!senderKey || !to) {
    return NextResponse.json(
      { error: "sender (traveller email) and to (shop number) are required." },
      { status: 400 }
    );
  }
  const limitRaw = Number(params.get("limit"));
  const path = await messagePath({
    senderKey,
    toDigits: to,
    ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
  });
  // `degraded` rides the payload - a partial trail must never present itself
  // as the whole story (the repo's signature defect class).
  return NextResponse.json(path, { headers: { "Cache-Control": "private, no-store" } });
}
