// WheelDeal workers - one Node process hosting all five BullMQ workers
// (1GB-VM memory plan: a single ~200MB process, not five). Each worker is a
// separate BullMQ consumer with its own concurrency; graceful shutdown drains
// in-flight jobs before exit so a deploy never drops a half-processed reply.

import { logger } from "@wheeldeal/shared";
import { startIncomingWorker } from "./incoming.worker";
import { startOutboundWorker } from "./outbound.worker";
import { startVisionWorker } from "./vision.worker";
import { startOutreachWorker } from "./outreach.worker";
import { startSchedulerWorker, scheduleHeartbeat } from "./scheduler.worker";

async function main() {
  const workers = [
    startIncomingWorker(),
    startOutboundWorker(),
    startVisionWorker(),
    startOutreachWorker(),
    startSchedulerWorker(),
  ];
  await scheduleHeartbeat();
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
