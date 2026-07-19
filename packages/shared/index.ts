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
