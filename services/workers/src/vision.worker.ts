// vision.worker - the ISOLATED media/OCR stage (Module 3).
//
// OWNER RULE: strict concurrency 2. Media buffers + raw LLM token streams are
// the RAM-spikiest work in the system; two at a time keeps the 1GB VM's OS
// ceiling safe no matter how many shops send photos at once.
//
// Per job (the Flow CHILD):
//   1. Resolve the thread (last outbound to this shop, scoped to the receiving
//      user) -> rfq + region. No thread -> ok:false (parent sends clarify).
//   2. fetchMediaBase64 with [0s,2s,5s] retry - the same backoff the inline
//      path used. Permanent failure (provider 404/500/expired) -> ok:false.
//   3. Best-effort audit copy to Supabase Storage (wa-media bucket). Failure
//      here NEVER fails the job - the bucket is optional.
//   4. extractOffer - the proven multi-provider OCR chain (chatVision tries
//      every Gemini vision model then Groq Llama-4 vision, never throws, and
//      degrades to the deterministic price-extract backstop on captions).
//   5. Return ONLY the small structured extraction - raw bytes never transit
//      Redis (160MB maxmemory).
//
// The job THROWS only on plausibly-transient infrastructure errors (so BullMQ
// retries with backoff); known-permanent outcomes return ok:false so the
// parent continuation can fire the never-silent clarify immediately.

import { Worker, type Job } from "bullmq";
import { extractOffer, sbSelect } from "@wheeldeal/core";
import { logger } from "@wheeldeal/shared";
import { bullConnection, drainImageWindow } from "@wheeldeal/redis";
import {
  VISION_QUEUE,
  type VisionExtractJob,
  type VisionChildResult,
} from "@wheeldeal/queues";
import type { StructuredRFQ } from "@/lib/types";
import { fetchMediaBase64 } from "@/lib/evolution";

const MEDIA_RETRY_DELAYS_MS = [0, 2000, 5000];

/** The thread context the OCR needs: the RFQ + region of the last outbound
 * THIS user sent this shop (the same lookup the agent loop does). */
async function threadContext(
  fromDigits: string,
  senderEmail: string
): Promise<{ rfq: StructuredRFQ; region?: string } | null> {
  const rows = await sbSelect<{ raw: { rfq?: StructuredRFQ; region?: string } | null }>(
    "whatsapp_messages",
    `select=raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
      fromDigits
    )}&raw->>sender=eq.${encodeURIComponent(senderEmail)}&order=received_at.desc&limit=1`
  ).catch(() => []);
  const raw = rows[0]?.raw;
  if (!raw?.rfq) return null;
  return { rfq: raw.rfq, region: typeof raw.region === "string" ? raw.region : undefined };
}

/** Compact recent history (oldest first) so the extractor never attributes OUR
 * counter-offers to the shop - same guarantee the inline path has. */
async function threadHistory(fromDigits: string, senderEmail: string): Promise<string> {
  const rows = await sbSelect<{ body: string | null; direction: string }>(
    "whatsapp_messages",
    `select=body,direction&or=(and(direction.eq.outbound,to_number.eq.${encodeURIComponent(
      fromDigits
    )},raw->>sender.eq.${encodeURIComponent(
      senderEmail
    )}),and(direction.eq.inbound,from_number.eq.${encodeURIComponent(
      fromDigits
    )},raw->>receiver.eq.${encodeURIComponent(senderEmail)}))&order=received_at.desc&limit=12`
  ).catch(() => []);
  return rows
    .reverse()
    .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 200)}`)
    .filter((l) => l.length > 4)
    .join("\n");
}

/** Best-effort audit copy of the blob to Supabase Storage (free tier).
 * Returns a storage ref or undefined - NEVER throws, never fails the job. */
async function storeMediaAudit(
  waMessageId: string,
  media: { mime: string; base64: string }
): Promise<string | undefined> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return undefined;
  try {
    const ext = media.mime.includes("png") ? "png" : media.mime.includes("webp") ? "webp" : "jpg";
    const path = `wa-media/${new Date().toISOString().slice(0, 10)}/${waMessageId || Date.now()}.${ext}`;
    const res = await fetch(`${base}/storage/v1/object/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": media.mime || "image/jpeg",
        "x-upsert": "true",
      },
      body: Buffer.from(media.base64, "base64"),
    });
    return res.ok ? path : undefined;
  } catch {
    return undefined;
  }
}

export function startVisionWorker(): Worker<VisionExtractJob, VisionChildResult> {
  const worker = new Worker<VisionExtractJob, VisionChildResult>(
    VISION_QUEUE,
    async (job: Job<VisionExtractJob>): Promise<VisionChildResult> => {
      const { waMessageId, fromDigits, senderEmail, caption, raw, coalesce } = job.data;
      const started = Date.now();

      // 1) Thread context - without an RFQ the extractor has no spec to match.
      const ctx = await threadContext(fromDigits, senderEmail);
      if (!ctx) return { ok: false, reason: "no-thread-context" };

      // 1b) COALESCE (Module 4.1): drain every frame buffered for this burst so
      // a multi-photo price board is OCR'd together in one pass. Falls back to
      // the single leader frame when the buffer is empty (Redis off / a retry
      // after the first drain).
      let frames: unknown[] = [raw];
      if (coalesce) {
        const drained = await drainImageWindow(coalesce);
        if (drained.length) frames = drained;
      }

      // 2) Media download with the proven backoff, for EVERY frame. A permanent
      // provider failure (expired media, 404/500) on a single frame is skipped;
      // only if NONE download do we clarify (business outcome, ok:false - no
      // infra retry on blobs that will never appear).
      const media: { mime: string; base64: string }[] = [];
      for (const frame of frames) {
        for (const wait of MEDIA_RETRY_DELAYS_MS) {
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          try {
            const m = await fetchMediaBase64(senderEmail, frame);
            if (m) {
              media.push(m);
              break;
            }
          } catch {
            /* retry this frame */
          }
        }
      }
      if (media.length === 0) {
        logger.warn({ waMessageId, fromDigits }, "vision: media permanently unavailable");
        return { ok: false, reason: "media-fetch-failed" };
      }

      // 3) Best-effort audit copy of the FIRST frame (never blocks/fails).
      const mediaRef = await storeMediaAudit(waMessageId, media[0]);

      // 4) The multi-provider OCR chain over ALL frames. extractOffer +
      // chatVision are already multi-image native (they map every image into
      // the prompt). extractOffer NEVER throws (Sun House fix): vision-down
      // degrades to the caption backstop or a clarify-shaped extraction.
      const extraction = await extractOffer(
        ctx.rfq,
        caption || "(the shop sent a price-list photo)",
        media,
        await threadHistory(fromDigits, senderEmail),
        ctx.region
      );

      logger.info(
        {
          waMessageId,
          fromDigits,
          images: media.length,
          ms: Date.now() - started,
          found: extraction.found,
          price: extraction.pricePerDay ?? null,
          mediaRef: mediaRef ?? null,
        },
        "vision extract done"
      );
      // 5) Small structured result only - bytes stay out of Redis.
      return { ok: true, mediaRef, extraction: extraction as unknown as Record<string, unknown> };
    },
    {
      connection: bullConnection(),
      // OWNER RULE: hard cap 2 - media buffers + LLM streams are the RAM
      // spike; the 1GB VM must never fan wider here.
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    // No DLQ copy needed: ignoreDependencyOnFailure means the parent
    // continuation ALWAYS runs and sends the never-silent clarify; the failed
    // child row itself (removeOnFail:false) is the forensic record.
    logger.warn(
      { jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
      "vision job failed (parent continuation still fires)"
    );
  });

  return worker;
}
