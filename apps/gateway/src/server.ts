// WheelDeal gateway - the always-on webhook ingress of the GCP architecture.
//
// Blueprint Module 1: acknowledge every WhatsApp webhook in <200ms so the
// provider never retries into a duplicate storm, and hand ALL work to BullMQ.
// The only I/O on the hot path is Redis (idempotency SETNX + queue add).
// Everything heavy - DB writes, media, LLMs, the agent turn - happens in the
// workers, off the request path, with retries + DLQ.

import express from "express";
import { webhookToken } from "@wheeldeal/core";
import { logger, env } from "@wheeldeal/shared";
import { claimInboundIds, redis } from "@wheeldeal/redis";
import { enqueueInbound } from "@wheeldeal/queues";
import { registerStreamRoute } from "./routes/stream";

const app = express();
app.use(express.json({ limit: "8mb" })); // Evolution payloads carry base64 previews

/** Provider message ids inside a webhook body (dedup keys). */
function inboundMessageIds(body: any): string[] {
  const items = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  return items
    .map((d: any) => String(d?.key?.id ?? ""))
    .filter((id: string) => id.length > 0);
}

// Health/readiness for compose + the GCP LB.
app.get("/healthz", async (_req, res) => {
  try {
    await redis().ping();
    res.json({ ok: true, redis: true });
  } catch {
    res.status(503).json({ ok: false, redis: false });
  }
});

// The Evolution webhook - same path shape as the legacy Next route, so
// cutting over is ONLY a URL change in the Evolution dashboard.
app.post(["/api/webhooks/evolution", "/webhooks/evolution"], async (req, res) => {
  const started = Date.now();
  try {
    const expected = await webhookToken();
    if (!expected || req.query.token !== expected) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== "object") {
      res.json({ ok: true });
      return;
    }

    // Ingress dedup (layer 1): all ids already seen -> ack, no enqueue.
    const ids = inboundMessageIds(body);
    const fresh = await claimInboundIds(ids);
    if (!fresh) {
      res.json({ ok: true, dedup: true });
      return;
    }

    // Enqueue (layer 2 dedup: jobId = first provider message id).
    await enqueueInbound(
      { channel: "evolution", receivedAtIso: new Date().toISOString(), raw: body },
      ids[0]
    );
    res.json({ ok: true });
  } catch (e) {
    // Never bounce a webhook for our own infra hiccup: ack + log. The provider
    // retry storm is worse than one investigated gap.
    logger.error({ err: (e as Error).message }, "webhook ingress error");
    res.json({ ok: true, degraded: true });
  } finally {
    const ms = Date.now() - started;
    if (ms > 200) logger.warn({ ms }, "webhook ack exceeded 200ms budget");
  }
});

// Realtime UI sync: SSE stream of session deltas (Module 2).
registerStreamRoute(app);

const port = Number(env("GATEWAY_PORT", "8080"));
const server = app.listen(port, () => {
  logger.info({ port }, "gateway listening");
});

// Graceful shutdown - finish in-flight acks, then close.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "gateway shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
