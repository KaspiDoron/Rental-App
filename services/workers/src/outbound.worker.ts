// outbound.worker - consumes outbound_queue (blueprint Module 6). Skeleton in
// Phase 1: sends still flow through the proven wa_outbox + guardOutbound path
// (drained by scheduler.worker). Module 6 moves the pacing/caps to Redis
// atomics and routes engine sends through this queue with BullMQ delay +
// rate-limiter; the queue + policy exist now so that change is additive.

import { Worker, type Job } from "bullmq";
import { guardOutbound, sendFromUser, afterSend } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection, recordIntro } from "@wheeldeal/redis";
import { OUTBOUND_QUEUE, type OutboundJob } from "@wheeldeal/queues";

export function startOutboundWorker(): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    OUTBOUND_QUEUE,
    async (job: Job<OutboundJob>) => {
      const { senderKey, toNumber, text, kind, meta } = job.data;
      // Full anti-ban gate at send time - identical to the legacy drain path.
      // queueIfBlocked: a guard hold parks into wa_outbox (the scheduler
      // heartbeat re-delivers) instead of burning a BullMQ retry.
      const verdict = await guardOutbound({
        senderKey,
        toDigits: toNumber,
        text,
        auto: true,
        queueIfBlocked: true,
        meta: { ...meta, kind },
      });
      if (!verdict.allow) {
        logger.info(
          { toNumber, kind, reason: verdict.reason, terminal: verdict.terminal },
          verdict.terminal ? "outbound dropped by guard" : "outbound parked by guard"
        );
        return;
      }
      const sent = await sendFromUser(senderKey, toNumber, verdict.text);
      if (!sent.ok) {
        throw new Error(sent.error || "send failed"); // retry with backoff
      }
      await afterSend(senderKey, toNumber).catch(() => {});
      // Module 6: an RFQ that actually LANDED is the one truth point for the
      // intro-window mirror (the guard may park/drop with no budget consumed;
      // replies/bargains never count). windowHours is stamped by the outreach
      // vendor job; default to the longest window (harmless - the ZSET trim
      // enforces the real window).
      if (kind === "rfq") {
        const windowHours = Number((meta as { windowHours?: number } | undefined)?.windowHours) || 6;
        await recordIntro(senderKey, toNumber, windowHours).catch(() => {});
      }
      logger.info({ toNumber, kind }, "outbound sent");
    },
    { connection: bullConnection(), concurrency: 2 }
  );
  return worker;
}
