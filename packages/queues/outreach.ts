// @wheeldeal/queues/outreach - the Module-6 cold-outreach batch flow.
//
// Topology (all on outreach_queue, dispatched by job name):
//
//   "batch"  ── one job per campaign. FAST: plan/budget gate + slice, then
//               fans out ONE delayed "vendor" job per shop (no block loop, no
//               LLM, no per-vendor Postgres). Idempotent via the batchId slot
//               marker + per-vendor jobIds.
//   "vendor" ── one job per shop, staggered 45-75s apart via BullMQ delay.
//               Compiles a unique opener and hands off to outbound_queue.
//   "sync"   ── one job per campaign terminal transition. The ISOLATED queue
//               event that batch-writes campaign state to Supabase (PostgREST,
//               zero pg-pool connections) and releases the concurrency slot.
//
// jobIds carry the dedup contract: a retried "batch" re-adding the same vendor
// is rejected by BullMQ (ov-<batchId>-<vendorId>), so the fan-out is exactly
// once; the completion "sync" is guarded by os-<batchId>-<state>.

import { type JobsOptions } from "bullmq";
import { OUTREACH_QUEUE, queue, safeJobId } from "./index";

// ---------------------------------------------------------------------------
// Names + DLQ
// ---------------------------------------------------------------------------

export const OUTREACH_DLQ = "outreach_dlq";

export const OUTREACH_BATCH = "batch";
export const OUTREACH_VENDOR = "vendor";
export const OUTREACH_SYNC = "sync";

// ---------------------------------------------------------------------------
// Typed job schemas
// ---------------------------------------------------------------------------

export interface OutreachVendorTarget {
  vendorId: string;
  toNumber: string;
}

/** The campaign job: everything the batch handler needs to gate + fan out.
 * `rfq` is typed loosely so the queues package stays free of a core dependency
 * at build time (the vision.ts precedent). */
export interface OutreachBatchJobV2 {
  batchId: string;
  userEmail: string;
  plan?: string;
  searchId?: number;
  region?: string;
  rfq: Record<string, unknown>;
  vendors: OutreachVendorTarget[];
}

/** One shop's send job (staggered). */
export interface OutreachVendorJob {
  batchId: string;
  userEmail: string;
  plan?: string;
  vendorId: string;
  toNumber: string;
  rfq: Record<string, unknown>;
  region?: string;
  /** The sender's rolling-window length - stamped so the outbound worker can
   * record the intro against the right window without a plan lookup. */
  windowHours: number;
  index: number;
  total: number;
}

/** The terminal campaign transition to persist. */
export interface OutreachSyncJob {
  batchId: string;
  userEmail: string;
  state: "completed" | "rejected" | "failed";
}

// ---------------------------------------------------------------------------
// jobIds (pure - unit-tested)
// ---------------------------------------------------------------------------

export function outreachBatchJobId(batchId: string): string | undefined {
  const id = safeJobId(batchId);
  return id ? `ob-${id}` : undefined;
}
export function outreachVendorJobId(batchId: string, vendorId: string): string | undefined {
  const b = safeJobId(batchId);
  const v = safeJobId(vendorId);
  return b && v ? `ov-${b}-${v}` : undefined;
}
export function outreachSyncJobId(batchId: string, state: string): string | undefined {
  const b = safeJobId(batchId);
  const s = safeJobId(state);
  return b && s ? `os-${b}-${s}` : undefined;
}

// ---------------------------------------------------------------------------
// Per-job-type retry options
// ---------------------------------------------------------------------------

/** The batch fan-out is cheap + idempotent - a short retry covers a Redis blip. */
export const OUTREACH_BATCH_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 500,
  removeOnFail: false,
};

/** A vendor job only compiles + enqueues (the REAL send retries live in
 * outbound's RETRY_POLICY). 3 attempts, never 5: an LLM-compile outage should
 * not burn 5x2min per shop across a 40-shop batch. */
export const OUTREACH_VENDOR_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 3000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/** The audit write must eventually land - a fuller retry ladder. */
export const OUTREACH_SYNC_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 500,
  removeOnFail: false,
};

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

export async function enqueueOutreachBatch(job: OutreachBatchJobV2): Promise<void> {
  await queue(OUTREACH_QUEUE).add(OUTREACH_BATCH, job, {
    ...OUTREACH_BATCH_OPTS,
    jobId: outreachBatchJobId(job.batchId),
  });
}

/** Fan out all vendor jobs in ONE pipelined addBulk (no herd of round-trips),
 * each with its staggered delay and dedup jobId. `delays[i]` pairs with
 * `jobs[i]`. */
export async function enqueueOutreachVendors(
  jobs: OutreachVendorJob[],
  delays: number[]
): Promise<void> {
  if (!jobs.length) return;
  await queue(OUTREACH_QUEUE).addBulk(
    jobs.map((data, i) => ({
      name: OUTREACH_VENDOR,
      data,
      opts: {
        ...OUTREACH_VENDOR_OPTS,
        delay: Math.max(0, delays[i] ?? 0),
        jobId: outreachVendorJobId(data.batchId, data.vendorId),
      },
    }))
  );
}

export async function enqueueOutreachSync(job: OutreachSyncJob): Promise<void> {
  await queue(OUTREACH_QUEUE).add(OUTREACH_SYNC, job, {
    ...OUTREACH_SYNC_OPTS,
    jobId: outreachSyncJobId(job.batchId, job.state),
  });
}
