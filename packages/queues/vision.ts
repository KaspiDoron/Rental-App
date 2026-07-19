// @wheeldeal/queues/vision - the Module-3 vision Flow (BullMQ FlowProducer).
//
// Topology per image turn:
//
//   PARENT  "vision-continuation"  on incoming_message_queue
//      └─ CHILD  "vision-extract"  on vision_queue   (strict concurrency 2)
//
// The CHILD does everything heavy - media download, Supabase Storage put,
// multi-provider LLM OCR - and returns only a SMALL structured extraction
// (never raw bytes: base64 blobs must not transit Redis on a 160MB cap).
// The PARENT runs when the child settles and composes the reply through the
// normal engine, or the NEVER-SILENT photo-clarify when the child failed.
//
// `ignoreDependencyOnFailure` is the never-silent keystone: even if the child
// exhausts its retries and FAILS, the parent still runs (with no child value)
// and sends the warm fallback - a shop is never left on read by a broken
// image, a provider 404/500, or a vision-model outage.

import { FlowProducer } from "bullmq";
import { bullConnection } from "../redis";
import { INCOMING_QUEUE, VISION_QUEUE, safeJobId } from "./index";

// ---------------------------------------------------------------------------
// Typed job schemas
// ---------------------------------------------------------------------------

/** Child job: isolated download + OCR. */
export interface VisionExtractJob {
  waMessageId: string;
  fromDigits: string;
  remoteJid: string;
  senderEmail: string;
  caption: string;
  /** The single provider message frame (carries the media keys/thumbnail). */
  raw: unknown;
}

/** Parent job: the turn continuation (composes the reply / fallback). */
export interface VisionContinuationJob {
  waMessageId: string;
  fromDigits: string;
  remoteJid: string;
  senderEmail: string;
  caption: string;
}

/** What the child RETURNS through the flow (small, structured, never bytes).
 * `extraction` is the core ExtractedOffer shape - typed loosely here so the
 * queues package does not depend on core's types at build time. */
export interface VisionChildResult {
  ok: boolean;
  reason?: string;
  /** Optional audit pointer to the stored blob in Supabase Storage. */
  mediaRef?: string;
  extraction?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// jobIds (pure - unit-tested): both sides key off the provider message id so
// a webhook redelivery can never spawn a second flow for the same photo.
// ---------------------------------------------------------------------------

export function visionChildJobId(waMessageId: string): string | undefined {
  const id = safeJobId(waMessageId);
  return id ? `vx-${id}` : undefined;
}
export function visionParentJobId(waMessageId: string): string | undefined {
  const id = safeJobId(waMessageId);
  return id ? `vc-${id}` : undefined;
}

// ---------------------------------------------------------------------------
// FlowProducer (lazy singleton - one blocking connection)
// ---------------------------------------------------------------------------

let producer: FlowProducer | null = null;
function flowProducer(): FlowProducer {
  if (!producer) producer = new FlowProducer({ connection: bullConnection() });
  return producer;
}

/**
 * Enqueue one image turn as a parent/child flow. Matches the
 * `VisionFlowRequest` shape core's ingest expects, so the incoming worker
 * injects THIS function straight into processEvolutionWebhook.
 */
export async function enqueueVisionFlow(req: {
  waMessageId: string;
  fromDigits: string;
  remoteJid: string;
  senderEmail: string;
  caption: string;
  raw: unknown;
}): Promise<void> {
  const continuation: VisionContinuationJob = {
    waMessageId: req.waMessageId,
    fromDigits: req.fromDigits,
    remoteJid: req.remoteJid,
    senderEmail: req.senderEmail,
    caption: req.caption,
  };
  const child: VisionExtractJob = { ...continuation, raw: req.raw };

  await flowProducer().add({
    name: "vision-continuation",
    queueName: INCOMING_QUEUE,
    data: continuation,
    opts: {
      jobId: visionParentJobId(req.waMessageId),
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
    children: [
      {
        name: "vision-extract",
        queueName: VISION_QUEUE,
        data: child,
        opts: {
          jobId: visionChildJobId(req.waMessageId),
          attempts: 3, // media/LLM upstreams are retried inside too - 3 is plenty
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 500,
          removeOnFail: false,
          // NEVER-SILENT keystone: a terminally-failed child must not strand
          // the parent in waiting-children - the parent runs anyway and sends
          // the warm text-clarify fallback.
          ignoreDependencyOnFailure: true,
        },
      },
    ],
  });
}
