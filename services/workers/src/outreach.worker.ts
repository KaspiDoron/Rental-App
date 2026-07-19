// outreach.worker - consumes outreach_queue (blueprint Module 6). Phase-1
// skeleton: cold batches still park into wa_outbox (drained 24/7 by
// scheduler.worker - already an upgrade: no app-open requirement). Module 6
// moves the fan-out here: one batch job -> per-shop delayed jobs, each
// compiling a UNIQUE opener (variedFirstMessage + ensureGloballyFresh) before
// enqueueing the send - the Pillar-5 monotony fix at the architecture level.

import { Worker, type Job } from "bullmq";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import { OUTREACH_QUEUE, type OutreachBatchJob } from "@wheeldeal/queues";

export function startOutreachWorker(): Worker<OutreachBatchJob> {
  const worker = new Worker<OutreachBatchJob>(
    OUTREACH_QUEUE,
    async (job: Job<OutreachBatchJob>) => {
      logger.info(
        { jobId: job.id, vendors: job.data.vendorIds.length },
        "outreach batch (Module 6 pending)"
      );
    },
    { connection: bullConnection(), concurrency: 1 }
  );
  return worker;
}
