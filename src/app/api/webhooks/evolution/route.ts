// Evolution API webhook - inbound messages from users' personal WhatsApp
// sessions (QR-connected in Profile). Feeds the same agentic loop as the
// official Cloud API webhook; auto-replies go back out through the SAME
// user's session, so the whole conversation stays authentic and in-app.
//
// The webhook URL we register includes ?token=<derived-from-api-key>, so
// random internet traffic cannot inject fake vendor replies.
//
// THIN ROUTE: the whole ingestion pipeline lives in src/lib/wa/ingest.ts
// (processEvolutionWebhook), shared verbatim with the BullMQ incoming.worker
// of the GCP migration - one brain, two transports. This route only
// authenticates, parses and delegates.

import { NextResponse } from "next/server";
import { webhookToken } from "@/lib/evolution";
import { processEvolutionWebhook } from "@/lib/wa/ingest";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const expected = await webhookToken();
  if (!expected || url.searchParams.get("token") !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: true });

  await processEvolutionWebhook(body, { origin: url.origin, token: expected });

  return NextResponse.json({ ok: true });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
