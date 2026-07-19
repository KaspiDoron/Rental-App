// scheduler.worker - the persistent heartbeat that REPLACES every external
// cron (blueprint Module 6): a repeatable BullMQ job drains the parked outbox
// (business-hours / pacing queue) and due graph wakeups (strategic waits)
// every 20s, 24/7, whether or not any user has the app open. This is the
// production fix for "no vercel.json cron + dropped tick fetch".

import { Worker, type Job } from "bullmq";
import { drainOutbox, drainGraphWakeups, sendFromUser } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import { queue, SCHEDULER_QUEUE, type SchedulerJob } from "@wheeldeal/queues";

const DRAIN_EVERY_MS = 20_000;

/** Register the repeatable drain job (idempotent - same repeat key). */
export async function scheduleHeartbeat(): Promise<void> {
  await queue(SCHEDULER_QUEUE).add(
    "drain",
    { kind: "drain" } satisfies SchedulerJob,
    {
      repeat: { every: DRAIN_EVERY_MS },
      jobId: "heartbeat-drain",
      removeOnComplete: 20,
      removeOnFail: 50,
    }
  );
}

export function startSchedulerWorker(): Worker<SchedulerJob> {
  const worker = new Worker<SchedulerJob>(
    SCHEDULER_QUEUE,
    async (job: Job<SchedulerJob>) => {
      if (job.data.kind === "drain") {
        // Same senders as the legacy drains: each user's own linked WhatsApp.
        await drainOutbox((senderKey, to, text) =>
          sendFromUser(senderKey, to, text)
        ).catch((e) => logger.warn({ err: (e as Error).message }, "outbox drain error"));
        await drainGraphWakeups((senderKey, to, text) =>
          sendFromUser(senderKey, to, text)
        ).catch((e) => logger.warn({ err: (e as Error).message }, "wakeup drain error"));
      }
      // "wakeup" | "dlq-sweep" | "gc" kinds land with Modules 2/3/6.
    },
    { connection: bullConnection(), concurrency: 1 } // one drainer - no herd
  );
  return worker;
}
