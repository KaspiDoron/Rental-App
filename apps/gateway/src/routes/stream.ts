// SSE stream (Module 2) - the realtime bridge from the VM to the Vercel
// frontend. Subscribes to the session's Redis pub/sub channel and forwards
// deltas as Server-Sent Events, so OFFERS IN / BARGAINED / new counters
// re-render the instant a worker writes them - no polling latency. Polling
// stays as the frontend's degraded fallback.
//
// AUTH (stateless, cross-origin): the VM holds no session store, so the Next
// app mints a short-lived token with the SHARED SESSION_SECRET:
//   token = <expEpochSeconds>.<hex hmacSha256(SESSION_SECRET, searchId+":"+exp)>
// We recompute + timing-safe compare, reject expired. CORS allow-origin comes
// from APP_DOMAIN so only the real frontend origin can read the stream.

import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@wheeldeal/shared";
import { subscribeSessionEvents, sessionAggregates } from "@wheeldeal/redis";

const HEARTBEAT_MS = 25_000;

export function streamToken(searchId: string, secret: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", secret).update(`${searchId}:${exp}`).digest("hex");
  return `${exp}.${sig}`;
}

export function verifyStreamToken(searchId: string, token: string, secret: string): boolean {
  const [expStr, sig] = String(token || "").split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !sig) return false;
  if (exp * 1000 < Date.now()) return false; // expired
  const expected = createHmac("sha256", secret).update(`${searchId}:${exp}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function corsOrigin(): string {
  const domain = process.env.APP_DOMAIN || "";
  if (!domain) return "*"; // pre-config dev default; APP_DOMAIN locks it down
  return domain.startsWith("http") ? domain : `https://${domain}`;
}

export function registerStreamRoute(app: Express): void {
  app.get("/api/stream/:searchId", async (req: Request, res: Response) => {
    const searchId = String(req.params.searchId || "");
    const secret = process.env.SESSION_SECRET || "";
    if (!searchId || !secret) {
      res.status(503).json({ error: "stream unavailable" });
      return;
    }
    if (!verifyStreamToken(searchId, String(req.query.token ?? ""), secret)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": corsOrigin(),
      "X-Accel-Buffering": "no", // nginx: never buffer the stream
    });
    res.write(": connected\n\n");

    // Initial snapshot so the client renders current truth immediately.
    const agg = await sessionAggregates(searchId);
    res.write(`event: state\ndata: ${JSON.stringify(agg)}\n\n`);

    const unsubscribe = subscribeSessionEvents(searchId, (e) => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
    logger.info({ searchId }, "sse stream opened");
  });
}
