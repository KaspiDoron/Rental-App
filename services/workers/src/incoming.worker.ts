// incoming.worker - consumes incoming_message_queue and runs the FULL inbound
// pipeline (blueprint Module 2 entry): the exact same processEvolutionWebhook
// the legacy Next route calls, now executing OFF the request path in a
// persistent process with BullMQ retries + DLQ. This is what kills the
// 10-minute "awaiting reply" stall: composition AND the opportunistic drains
// run here every time, no dropped fire-and-forget fetch, no missing cron.

import { Worker, type Job } from "bullmq";
import { processEvolutionWebhook } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import {
  INCOMING_QUEUE,
  INCOMING_DLQ,
  sendToDlq,
  type InboundJob,
} from "@wheeldeal/queues";

export function startIncomingWorker(): Worker<InboundJob> {
  const worker = new Worker<InboundJob>(
    INCOMING_QUEUE,
    async (job: Job<InboundJob>) => {
      const started = Date.now();
      // No origin/token passed: this process IS the follow-up runner - the
      // in-request tick chain is a serverless workaround we no longer need.
      await processEvolutionWebhook(job.data.raw);
      logger.info(
        { jobId: job.id, ms: Date.now() - started, channel: job.data.channel },
        "inbound processed"
      );
    },
    { connection: bullConnection(), concurrency: 8 }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    logger.warn(
      { jobId: job.id, attempt: job.attemptsMade, err: err.message },
      "inbound job failed"
    );
    // Exhausted retries -> copy to the DLQ for Bull Board forensics/replay.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await sendToDlq(INCOMING_DLQ, job.data, err.message).catch(() => {});
      logger.error({ jobId: job.id }, "inbound job moved to DLQ");
    }
  });

  return worker;
}
