// scheduler.worker - the persistent heartbeat that REPLACES every external
// cron (blueprint Module 6): a repeatable BullMQ job drains the parked outbox
// (business-hours / pacing queue) and due graph wakeups (strategic waits)
// every 20s, 24/7, whether or not any user has the app open. This is the
// production fix for "no vercel.json cron + dropped tick fetch".

import { Worker, type Job } from "bullmq";
import { drainOutbox, drainGraphWakeups, sendFromUser } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import {
  queue,
  SCHEDULER_QUEUE,
  OUTREACH_QUEUE,
  OUTREACH_DLQ,
  INCOMING_DLQ,
  type SchedulerJob,
} from "@wheeldeal/queues";

const DRAIN_EVERY_MS = 20_000;
const GC_EVERY_MS = 30 * 60_000; // 30m
const DLQ_SWEEP_EVERY_MS = 15 * 60_000; // 15m

/** Register the repeatable heartbeat jobs (idempotent - same repeat keys). */
export async function scheduleHeartbeat(): Promise<void> {
  const q = queue(SCHEDULER_QUEUE);
  await q.add("drain", { kind: "drain" } satisfies SchedulerJob, {
    repeat: { every: DRAIN_EVERY_MS },
    jobId: "heartbeat-drain",
    removeOnComplete: 20,
    removeOnFail: 50,
  });
  // GC (Module 6): budget keys all carry TTLs and slot counters self-heal in
  // <=6h, so there is nothing to DELETE - this is an OBSERVABILITY sweep only
  // (no SCAN on the shared 160MB instance). It logs queue + DLQ health.
  await q.add("gc", { kind: "gc" } satisfies SchedulerJob, {
    repeat: { every: GC_EVERY_MS },
    jobId: "heartbeat-gc",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
  // DLQ depth alerting surface (no mutation).
  await q.add("dlq-sweep", { kind: "dlq-sweep" } satisfies SchedulerJob, {
    repeat: { every: DLQ_SWEEP_EVERY_MS },
    jobId: "heartbeat-dlq",
    removeOnComplete: 10,
    removeOnFail: 20,
  });
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
      } else if (job.data.kind === "gc") {
        // Observability sweep - all budget keys carry TTLs, nothing to delete.
        const counts = await queue(OUTREACH_QUEUE)
          .getJobCounts("waiting", "active", "delayed", "failed")
          .catch(() => ({}));
        logger.info({ outreach: counts }, "heartbeat gc - queue health");
      } else if (job.data.kind === "dlq-sweep") {
        const [outreach, incoming] = await Promise.all([
          queue(OUTREACH_DLQ).getJobCounts("waiting").catch(() => ({})),
          queue(INCOMING_DLQ).getJobCounts("waiting").catch(() => ({})),
        ]);
        const depth =
          Number((outreach as { waiting?: number }).waiting ?? 0) +
          Number((incoming as { waiting?: number }).waiting ?? 0);
        if (depth > 0) logger.warn({ outreach, incoming }, "DLQ depth > 0 - inspect Bull Board");
        else logger.info({ outreach, incoming }, "heartbeat dlq-sweep - clean");
      }
    },
    { connection: bullConnection(), concurrency: 1 } // one drainer - no herd
  );
  return worker;
}
