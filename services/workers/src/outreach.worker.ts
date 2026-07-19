// outreach.worker - consumes outreach_queue (Modules 4 + 6). One batch job
// fans into per-shop sends, each with its OWN deterministically-compiled
// opener (Module 4's variation matrix: seed = user|vendor|batchId) checked
// through the global-uniqueness guard - the architecture-level kill for the
// "identical opener to 40 shops" spam fingerprint. Sends are staggered
// 45-75s apart via BullMQ delay and each passes the full anti-ban guard in
// outbound.worker at ITS send time. (Plan-tier rolling-window budgets move
// here in Module 6; the wa-guard budget still applies per send today.)

import { Worker, type Job } from "bullmq";
import { compileOpener, openerSeed, ensureGloballyUnique } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import {
  OUTREACH_QUEUE,
  enqueueOutbound,
  type OutreachBatchJob,
} from "@wheeldeal/queues";
import type { StructuredRFQ } from "@/lib/types";

/** 45-75s jittered stagger, deterministic per (batch, index). */
function staggerMs(index: number, jitterSeed: number): number {
  const jitter = ((jitterSeed * 2654435761 + index * 40503) >>> 16) % 30_000;
  return index * 45_000 + jitter;
}

export interface OutreachBatchData extends OutreachBatchJob {
  rfq?: StructuredRFQ;
  region?: string;
  /** vendorId -> WhatsApp digits. */
  numbers?: Record<string, string>;
}

export function startOutreachWorker(): Worker<OutreachBatchData> {
  const worker = new Worker<OutreachBatchData>(
    OUTREACH_QUEUE,
    async (job: Job<OutreachBatchData>) => {
      const { userEmail, vendorIds, rfq, region, numbers } = job.data;
      if (!rfq || !numbers) {
        logger.warn({ jobId: job.id }, "outreach batch missing rfq/numbers - skipped");
        return;
      }
      const recent: string[] = [];
      let index = 0;
      for (const vendorId of vendorIds) {
        const toNumber = numbers[vendorId];
        if (!toNumber) continue;
        // Per-shop compile + two-layer uniqueness (in-batch list + the
        // cross-fleet Redis signature window; the accepted sig is recorded).
        const compiled = compileOpener(
          rfq,
          openerSeed(userEmail, vendorId, String(job.id ?? "batch")),
          region
        );
        const unique = await ensureGloballyUnique(compiled, recent);
        recent.push(unique.text);
        await enqueueOutbound(
          { senderKey: userEmail, toNumber, text: unique.text, kind: "rfq", meta: { vendorId, region } },
          staggerMs(index, job.timestamp ?? 0)
        );
        index++;
      }
      logger.info(
        { jobId: job.id, vendors: index, of: vendorIds.length },
        "outreach batch fanned out (unique openers, 45-75s stagger)"
      );
    },
    { connection: bullConnection(), concurrency: 1 }
  );
  return worker;
}
