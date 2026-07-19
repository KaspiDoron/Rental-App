// incoming.worker - consumes incoming_message_queue (blueprint Modules 1-3).
//
// Two job shapes share this queue:
//   "inbound"             - a raw webhook payload: run the FULL pipeline
//                           (processEvolutionWebhook). Image turns are
//                           OFFLOADED via the injected vision Flow enqueue.
//   "vision-continuation" - the PARENT of a vision Flow: runs after the child
//                           settles. Composes the reply from the child's
//                           extraction - or the NEVER-SILENT photo-clarify
//                           when the child failed/returned nothing usable -
//                           through the normal engine (guard + human delay).

import { Worker, type Job } from "bullmq";
import {
  processEvolutionWebhook,
  processVendorReply,
  photoClarifyExtraction,
  sendFromUser,
  type ExtractedOffer,
} from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection } from "@wheeldeal/redis";
import {
  INCOMING_QUEUE,
  INCOMING_DLQ,
  sendToDlq,
  enqueueVisionFlow,
  type InboundJob,
  type VisionContinuationJob,
  type VisionChildResult,
} from "@wheeldeal/queues";

/** The child's settled value, if any (absent when the child failed terminally
 * - ignoreDependencyOnFailure lets the parent run regardless). */
function childResult(values: Record<string, unknown>): VisionChildResult | null {
  for (const v of Object.values(values)) {
    if (v && typeof v === "object" && "ok" in (v as Record<string, unknown>)) {
      return v as VisionChildResult;
    }
  }
  return null;
}

async function runContinuation(job: Job<VisionContinuationJob>): Promise<void> {
  const { waMessageId, fromDigits, remoteJid, senderEmail, caption } = job.data;
  const child = childResult(await job.getChildrenValues());

  // Usable OCR result -> compose with it. Anything else -> the never-silent
  // warm clarify. Both paths run the FULL engine turn (privacy scoping,
  // guardrails, anti-ban guard, human-delay park) - only extraction differs.
  const usable = child?.ok && child.extraction ? (child.extraction as unknown as ExtractedOffer) : null;
  const preExtracted: ExtractedOffer = usable ?? photoClarifyExtraction();
  if (!usable) {
    logger.warn(
      { waMessageId, fromDigits, reason: child?.reason ?? "child-failed" },
      "vision continuation: falling back to never-silent clarify"
    );
  }

  await processVendorReply({
    fromDigits,
    remoteJid,
    text: caption,
    images: [], // bytes never re-enter the turn - extraction already happened
    transcript: null,
    waMessageId,
    senderEmail,
    humanDelay: true,
    preExtracted,
    send: async (to, message) => sendFromUser(senderEmail, to, message),
  });
}

export function startIncomingWorker(): Worker {
  const worker = new Worker(
    INCOMING_QUEUE,
    async (job: Job) => {
      const started = Date.now();
      if (job.name === "vision-continuation") {
        await runContinuation(job as Job<VisionContinuationJob>);
        logger.info(
          { jobId: job.id, ms: Date.now() - started },
          "vision continuation processed"
        );
        return;
      }
      // Default: a raw inbound webhook payload. Inject the vision Flow
      // enqueue (dependency inversion - core never imports BullMQ) so image
      // turns offload to the isolated pipeline; no origin/token: this
      // persistent process replaces the serverless tick chain.
      const data = (job as Job<InboundJob>).data;
      await processEvolutionWebhook(data.raw, { enqueueVisionFlow });
      logger.info(
        { jobId: job.id, ms: Date.now() - started, channel: data.channel },
        "inbound processed"
      );
    },
    { connection: bullConnection(), concurrency: 8 }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    logger.warn(
      { jobId: job.id, name: job.name, attempt: job.attemptsMade, err: err.message },
      "incoming job failed"
    );
    // Exhausted retries -> DLQ for Bull Board forensics/replay.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await sendToDlq(INCOMING_DLQ, { name: job.name, data: job.data }, err.message).catch(() => {});
      logger.error({ jobId: job.id, name: job.name }, "incoming job moved to DLQ");
    }
  });

  return worker;
}
