// outreach.worker - the Module-6 cold-outreach batch flow. One Worker on
// outreach_queue dispatches three job kinds so a 40-shop campaign NEVER runs a
// block loop and NEVER hits Postgres per shop:
//
//   "batch"  ── FAST gate + fan-out. Claims a plan-tier concurrency slot
//               (Redis), reads the intro-window budget (Redis mirror, seeded
//               once from Postgres), slices vendors to the remaining budget,
//               then addBulk-fans ONE delayed "vendor" job per shop (45-75s
//               structural gap, hour-window aware). No LLM, no per-vendor DB.
//   "vendor" ── one shop: compile a globally-unique opener (Module 4) and hand
//               to outbound_queue (which runs the full anti-ban guard at send
//               time). Records progress; the LAST vendor fires the sync job.
//   "sync"   ── the ISOLATED queue event (P3): batch-writes campaign state to
//               Supabase via PostgREST (zero pg-pool connections) and releases
//               the concurrency slot. <=2 PostgREST calls per campaign lifetime.
//
// Idempotency: the batch slot marker + per-vendor jobIds make the fan-out
// exactly-once under retries; the pending counter decrements per TERMINAL
// outcome (success in-handler, terminal failure in the `failed` listener -
// NEVER a finally-block, which would double-count across attempts) and the
// completion sync fires only on strict pending===0, double-guarded by the
// os-<batchId> jobId.
//
// Cancellation note: a user cancel (CANCEL_GUARD) kills sends at guard time in
// the outbound worker; already-fanned vendor jobs still dispatch + count, so a
// campaign summary reports DISPATCHED - whatsapp_messages stays the send truth.

import { Worker, type Job } from "bullmq";
import {
  compileOpener,
  openerSeed,
  ensureGloballyUnique,
  planCapacity,
  cappedStaggerOffsets,
  newContactBudget,
  introductionsInWindow,
  sbInsert,
} from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import {
  bullConnection,
  introUsage,
  seedIntroWindow,
  tryAcquireCampaignSlot,
  releaseCampaignSlot,
  initCampaign,
  bumpCampaign,
  completeVendorJob,
  setCampaignState,
  readCampaign,
} from "@wheeldeal/redis";
import {
  OUTREACH_QUEUE,
  OUTREACH_DLQ,
  OUTREACH_BATCH,
  OUTREACH_VENDOR,
  OUTREACH_SYNC,
  enqueueOutbound,
  enqueueOutreachVendors,
  enqueueOutreachSync,
  sendToDlq,
  type OutreachBatchJobV2,
  type OutreachVendorJob,
  type OutreachSyncJob,
  type OutreachVendorTarget,
} from "@wheeldeal/queues";
import type { StructuredRFQ } from "@/lib/types";

type AnyJob = OutreachBatchJobV2 | OutreachVendorJob | OutreachSyncJob;

// Legacy Module-4 batch payload (vendorIds + numbers map). Zero producers, but
// normalized here so a stale enqueued job never strands the queue.
interface LegacyBatchJob {
  vendorIds?: string[];
  numbers?: Record<string, string>;
}

function normalizeVendors(data: OutreachBatchJobV2 & LegacyBatchJob): OutreachVendorTarget[] {
  if (Array.isArray(data.vendors) && data.vendors.length) return data.vendors;
  const ids = data.vendorIds ?? [];
  const numbers = data.numbers ?? {};
  return ids
    .map((vendorId) => ({ vendorId, toNumber: numbers[vendorId] }))
    .filter((v): v is OutreachVendorTarget => Boolean(v.toNumber));
}

// ---------------------------------------------------------------------------
// batch handler - gate + fan out (no block loop, no LLM)
// ---------------------------------------------------------------------------

async function handleBatch(job: Job<OutreachBatchJobV2 & LegacyBatchJob>): Promise<void> {
  const data = job.data;
  const { batchId, userEmail } = data;
  const rfq = data.rfq as unknown as StructuredRFQ | undefined;
  if (!batchId || !userEmail || !rfq) {
    logger.warn({ jobId: job.id }, "outreach batch missing batchId/userEmail/rfq - skipped");
    return;
  }
  const plan = data.plan ?? "free";
  const cap = planCapacity(plan);

  // 1. Concurrency slot (Redis). null => Redis off => fail open (the send-time
  //    guard still bounds every message).
  const slot = await tryAcquireCampaignSlot(userEmail, batchId, cap.concurrentCampaigns);
  if (slot && slot.ok === false) {
    logger.info(
      { batchId, userEmail, active: slot.active, cap: slot.cap },
      "outreach batch rejected - concurrent-campaign cap reached"
    );
    await initCampaign(batchId, { userEmail, plan, total: 0, skipped: 0 });
    await setCampaignState(batchId, "rejected");
    await enqueueOutreachSync({ batchId, userEmail, state: "rejected" });
    return;
  }

  // 2. Intro-window budget (Redis mirror, seeded once from Postgres).
  let remaining = await introUsage(userEmail, cap.windowHours).then((used) =>
    used === null ? null : Math.max(0, cap.newContacts - used)
  );
  if (remaining === null) {
    // Mirror not seeded (or Redis off). Seed it from the authoritative window,
    // and use that same read for the budget so we never send blind.
    try {
      const win = await introductionsInWindow(userEmail, cap.windowHours);
      await seedIntroWindow(userEmail, cap.windowHours, win.entries);
      remaining = Math.max(0, cap.newContacts - win.count);
    } catch {
      // Postgres window read failed too - fall back to the guard's own budget.
      const budget = await newContactBudget(userEmail, plan).catch(() => ({
        remaining: cap.newContacts,
      }));
      remaining = budget.remaining;
    }
  }

  // 3. Dedup by number, slice to the budget (overflow = reported skipped).
  const seen = new Set<string>();
  const all = normalizeVendors(data).filter((v) => {
    if (!v.toNumber || seen.has(v.toNumber)) return false;
    seen.add(v.toNumber);
    return true;
  });
  const take = all.slice(0, remaining);
  const skipped = all.length - take.length;

  if (!take.length) {
    logger.info({ batchId, remaining, skipped }, "outreach batch has no budget - nothing fanned out");
    await initCampaign(batchId, { userEmail, plan, total: 0, skipped });
    await setCampaignState(batchId, "completed");
    await enqueueOutreachSync({ batchId, userEmail, state: "completed" });
    return;
  }

  // 4. Structural 45-75s stagger, hour-window aware (reuses the drain's math).
  const delays = cappedStaggerOffsets(take.length, cap.hourCap, 45);

  // 5. Init the progress hash, then fan out in ONE pipelined addBulk.
  await initCampaign(batchId, { userEmail, plan, total: take.length, skipped });
  const vendorJobs: OutreachVendorJob[] = take.map((v, index) => ({
    batchId,
    userEmail,
    plan,
    vendorId: v.vendorId,
    toNumber: v.toNumber,
    rfq: rfq as unknown as Record<string, unknown>,
    region: data.region,
    windowHours: cap.windowHours,
    index,
    total: take.length,
  }));
  await enqueueOutreachVendors(vendorJobs, delays);

  logger.info(
    { batchId, fannedOut: take.length, skipped, of: all.length },
    "outreach batch fanned out (budget-gated, staggered vendor jobs)"
  );
}

// ---------------------------------------------------------------------------
// vendor handler - compile a unique opener + hand to outbound
// ---------------------------------------------------------------------------

async function handleVendor(job: Job<OutreachVendorJob>): Promise<void> {
  const { batchId, userEmail, vendorId, toNumber, rfq, region, windowHours } = job.data;
  const compiled = compileOpener(
    rfq as unknown as StructuredRFQ,
    // Seed on batchId (NOT job.id) so a retried attempt compiles identically.
    openerSeed(userEmail, vendorId, batchId),
    region
  );
  // Cross-vendor uniqueness is carried entirely by the Redis copy:sigs window
  // (Module 4) - the old in-memory recent[] of the block loop is gone with it.
  const unique = await ensureGloballyUnique(compiled, []);
  await enqueueOutbound(
    {
      senderKey: userEmail,
      toNumber,
      text: unique.text,
      kind: "rfq",
      meta: { vendorId, batchId, region, windowHours },
    },
    0 // the structural stagger already lives in THIS job's delay
  );

  await bumpCampaign(batchId, "dispatched");
  const left = await completeVendorJob(batchId);
  if (left === 0) {
    await setCampaignState(batchId, "completed");
    await enqueueOutreachSync({ batchId, userEmail, state: "completed" });
  }
}

// ---------------------------------------------------------------------------
// sync handler - the isolated Supabase write + slot release (P3)
// ---------------------------------------------------------------------------

async function handleSync(job: Job<OutreachSyncJob>): Promise<void> {
  const { batchId, userEmail, state } = job.data;
  const hash = await readCampaign(batchId);
  const total = Number(hash.total ?? 0);
  const failed = Number(hash.failed ?? 0);
  const dispatched = Number(hash.dispatched ?? 0);
  const skipped = Number(hash.skipped ?? 0);
  const terminal = state === "completed" && total > 0 && failed >= total ? "failed" : state;

  // ONE PostgREST write (zero pg-pool connections) - the campaign audit row.
  // Migration-free: the summary rides in the existing `detail` text column.
  await sbInsert("agent_events", [
    {
      kind: "outreach-campaign",
      vendor_id: batchId,
      vendor_name: userEmail,
      detail: JSON.stringify({ batchId, state: terminal, total, dispatched, failed, skipped }),
    },
  ]).catch((e: unknown) =>
    logger.warn({ batchId, err: String(e) }, "outreach campaign sync write failed")
  );

  if (terminal !== state) await setCampaignState(batchId, terminal);
  await releaseCampaignSlot(userEmail, batchId);
  logger.info(
    { batchId, state: terminal, total, dispatched, failed, skipped },
    "outreach campaign synced"
  );
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

export function startOutreachWorker(): Worker<AnyJob> {
  const worker = new Worker<AnyJob>(
    OUTREACH_QUEUE,
    async (job: Job<AnyJob>) => {
      switch (job.name) {
        case OUTREACH_BATCH:
          return handleBatch(job as Job<OutreachBatchJobV2 & LegacyBatchJob>);
        case OUTREACH_VENDOR:
          return handleVendor(job as Job<OutreachVendorJob>);
        case OUTREACH_SYNC:
          return handleSync(job as Job<OutreachSyncJob>);
        default:
          logger.warn({ name: job.name }, "outreach worker got unknown job name - skipped");
      }
    },
    { connection: bullConnection(), concurrency: 2 }
  );

  // Terminal-failure leg: decrement pending ONCE here (not in a finally, which
  // would double-count across retried attempts), copy to the DLQ, and fire the
  // completion sync if this was the last outstanding vendor.
  worker.on("failed", (job, err) => {
    void (async () => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts) return; // more retries pending - not terminal
      const reason = err?.message || "outreach job failed";
      try {
        if (job.name === OUTREACH_VENDOR) {
          const d = job.data as OutreachVendorJob;
          await bumpCampaign(d.batchId, "failed");
          const left = await completeVendorJob(d.batchId);
          if (left === 0) {
            await setCampaignState(d.batchId, "completed");
            await enqueueOutreachSync({ batchId: d.batchId, userEmail: d.userEmail, state: "completed" });
          }
          await sendToDlq(OUTREACH_DLQ, job.data, reason);
        } else if (job.name === OUTREACH_BATCH) {
          const d = job.data as OutreachBatchJobV2;
          await setCampaignState(d.batchId, "failed");
          await releaseCampaignSlot(d.userEmail, d.batchId);
          await enqueueOutreachSync({ batchId: d.batchId, userEmail: d.userEmail, state: "failed" });
          await sendToDlq(OUTREACH_DLQ, job.data, reason);
        }
      } catch (e) {
        logger.error({ jobId: job.id, err: String(e) }, "outreach failed-handler error");
      }
    })();
  });

  return worker;
}
