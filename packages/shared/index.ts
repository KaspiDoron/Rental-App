// @wheeldeal/shared - config + logging for the GCP services.

import pino from "pino";

/** Structured JSON logger; level via LOG_LEVEL (default info). */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: process.env.SERVICE_NAME || "wheeldeal" },
});

/** Required env read that fails LOUDLY at boot, not silently at 3am. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/** Optional env with default. */
export function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** The one Redis connection string every service shares. */
export function redisUrl(): string {
  return env("REDIS_URL", "redis://127.0.0.1:6379");
}

/**
 * Last-resort process guards for the long-running services.
 *
 * Neither the gateway nor the workers had these, so a single escaped rejection
 * took the whole process down with no explanation - and both services float
 * promises by design (fire-and-forget failure legs, async signal handlers), so
 * escapes are a question of when, not if.
 *
 * The two events get deliberately DIFFERENT treatment:
 *  - unhandledRejection: log and keep serving. One bad job must not take down
 *    the other four workers or the webhook ingress.
 *  - uncaughtException: the process state is no longer trustworthy, so log,
 *    give the logger a moment to flush, and exit non-zero. The orchestrator
 *    (Render / systemd / Cloud Run) restarts us clean - a fast honest restart
 *    beats limping on with corrupted state.
 *
 * Idempotent: calling twice installs one set of listeners.
 */
let guardsInstalled = false;
export function installProcessGuards(name: string): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ service: name, err: err.message, stack: err.stack }, "unhandledRejection (surviving)");
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ service: name, err: err.message, stack: err.stack }, "uncaughtException (exiting)");
    // Do not await anything here - the process is already unsound. Give pino a
    // tick to flush, then die so we are restarted clean.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
