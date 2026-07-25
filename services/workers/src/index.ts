// WheelDeal workers - one Node process hosting all five BullMQ workers
// (1GB-VM memory plan: a single ~200MB process, not five). Each worker is a
// separate BullMQ consumer with its own concurrency; graceful shutdown drains
// in-flight jobs before exit so a deploy never drops a half-processed reply.

import { logger } from "@wheeldeal/shared";
import { startIncomingWorker } from "./incoming.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startVisionWorker } from "./vision.worker";
import { startOutreachWorker } from "./outreach.worker";
import { startSchedulerWorker, scheduleHeartbeat, rearmOpenWebhooks } from "./scheduler.worker";

async function main() {
  const workers = [
    startIncomingWorker(),
    startOutboundWorker(),
    startVisionWorker(),
    startOutreachWorker(),
    startSchedulerWorker(),
  ];
  await scheduleHeartbeat();
  // Immediate one-shot webhook re-arm on boot so a deploy (e.g. after a secret
  // rotation) pushes the current-token URL to Evolution right away, rather than
  // waiting for the first 30m repeatable tick. Best-effort; never blocks boot.
  rearmOpenWebhooks()
    .then((r) => logger.info(r, "boot webhook re-arm"))
    .catch((e) => logger.warn({ err: (e as Error).message }, "boot webhook re-arm failed"));
  logger.info({ workers: workers.length }, "workers up (heartbeat drain every 20s)");

  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ sig }, "workers shutting down (draining in-flight jobs)");
      await Promise.allSettled(workers.map((w) => w.close()));
      process.exit(0);
    });
  }
}

main().catch((e) => {
  logger.error({ err: (e as Error).message }, "workers failed to start");
  process.exit(1);
});
