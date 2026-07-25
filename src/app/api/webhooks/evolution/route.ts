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
import { noteWebhookAccepted, noteWebhook403 } from "@/lib/wa/webhook-trace";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const presented = url.searchParams.get("token");
  const expected = await webhookToken();
  if (!expected || presented !== expected) {
    // Leave a throttled breadcrumb (per process) so a stale-token 403 storm is
    // visible in-app instead of silent. NO body parse, NO full token logged.
    void noteWebhook403("webhooks/evolution", presented);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: true });

  // Durable "last inbound accepted at" (throttled per instance).
  void noteWebhookAccepted(String((body as { instance?: string; instanceName?: string })?.instance ?? (body as { instanceName?: string })?.instanceName ?? "") || undefined, String((body as { event?: string })?.event ?? "") || undefined);

  await processEvolutionWebhook(body, { origin: url.origin, token: expected });

  return NextResponse.json({ ok: true });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
