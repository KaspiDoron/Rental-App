// @wheeldeal/queues - every BullMQ queue in the system, with typed job
// schemas, the shared retry/DLQ policy, and enqueue helpers. Workers import
// the names + types from here so a queue can never be misspelled into limbo.

import { Queue, type JobsOptions } from "bullmq";
import { bullConnection } from "../redis";

// ---------------------------------------------------------------------------
// Names (blueprint Modules 1-6)
// ---------------------------------------------------------------------------

export const INCOMING_QUEUE = "incoming_message_queue";
export const INCOMING_DLQ = "incoming_message_dlq";
export const OUTBOUND_QUEUE = "outbound_queue";
export const VISION_QUEUE = "vision_queue";
export const OUTREACH_QUEUE = "outreach_queue";
export const SCHEDULER_QUEUE = "scheduler_queue";

// ---------------------------------------------------------------------------
// Typed job payloads
// ---------------------------------------------------------------------------

export interface InboundJob {
  channel: "evolution" | "meta";
  receivedAtIso: string;
  /** Raw provider webhook payload - processed by core's ingest function. */
  raw: unknown;
}

export interface OutboundJob {
  senderKey: string; // the user whose WhatsApp sends
  toNumber: string;
  text: string;
  kind: string; // rfq | bargain | reply | ...
  meta?: Record<string, unknown>;
}

// Vision flow job schemas live in ./vision (re-exported at the bottom).

export interface OutreachBatchJob {
  userEmail: string;
  searchId?: number;
  vendorIds: string[];
}

export interface SchedulerJob {
  kind: "drain" | "wakeup" | "dlq-sweep" | "gc";
  threadKey?: string;
}

// ---------------------------------------------------------------------------
// Shared policy
// ---------------------------------------------------------------------------

/** Blueprint Module 1: 5 attempts, exponential 2s backoff (2/4/8/16/32s). */
export const RETRY_POLICY: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false, // kept for the DLQ copy + Bull Board forensics
};

// One lazily-created Queue per name (each with its own connection - BullMQ
// requires maxRetriesPerRequest:null which the shared command client avoids).
const queues = new Map<string, Queue>();
export function queue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: bullConnection() });
    queues.set(name, q);
  }
  return q;
}

/** BullMQ jobIds must avoid ":" (key separator) - sanitize provider ids. */
export function safeJobId(id: string | undefined | null): string | undefined {
  const cleaned = (id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || undefined;
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/** Layer-2 dedup: jobId = provider message id (BullMQ rejects duplicates). */
export async function enqueueInbound(job: InboundJob, dedupeId?: string): Promise<void> {
  await queue(INCOMING_QUEUE).add("inbound", job, {
    ...RETRY_POLICY,
    jobId: safeJobId(dedupeId),
  });
}

export async function enqueueOutbound(job: OutboundJob, delayMs = 0): Promise<void> {
  await queue(OUTBOUND_QUEUE).add("send", job, { ...RETRY_POLICY, delay: delayMs });
}

export async function enqueueOutreachBatch(job: OutreachBatchJob): Promise<void> {
  await queue(OUTREACH_QUEUE).add("batch", job, RETRY_POLICY);
}

/** Copy an exhausted job into the DLQ (called from workers' failed handler). */
export async function sendToDlq(
  dlqName: string,
  data: unknown,
  failedReason: string
): Promise<void> {
  await queue(dlqName).add(
    "dead",
    { data, failedReason, at: new Date().toISOString() },
    { removeOnComplete: false, removeOnFail: false }
  );
}

// Vision flow (Module 3) - kept at the bottom: vision.ts imports the queue
// names/helpers above, so re-exporting last keeps the ESM cycle trivially safe.
export {
  enqueueVisionFlow,
  visionChildJobId,
  visionParentJobId,
} from "./vision";
export type {
  VisionExtractJob,
  VisionContinuationJob,
  VisionChildResult,
} from "./vision";
