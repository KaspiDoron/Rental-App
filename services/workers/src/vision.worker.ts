// vision.worker - consumes vision_queue (blueprint Module 3). Phase-1
// skeleton: media is currently handled inline by processEvolutionWebhook
// (fetchMediaWithRetry -> extractOffer vision path, which already degrades
// gracefully). Module 3 splits that into a BullMQ Flow (parent turn + this
// child) so the LLM-expensive OCR runs at its own low concurrency with a
// generous timeout, never blocking the fast inbound turns.

import { Worker, type Job } from "bullmq";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import { VISION_QUEUE, type VisionJob } from "@wheeldeal/queues";

export function startVisionWorker(): Worker<VisionJob> {
  const worker = new Worker<VisionJob>(
    VISION_QUEUE,
    async (job: Job<VisionJob>) => {
      // Module 3 lands here: fetch media -> chatVision OCR -> extractOffer ->
      // offers row + Redis aggregates -> resolve parent Flow.
      logger.info({ jobId: job.id, threadKey: job.data.threadKey }, "vision job (Module 3 pending)");
    },
    { connection: bullConnection(), concurrency: 3 }
  );
  return worker;
}
