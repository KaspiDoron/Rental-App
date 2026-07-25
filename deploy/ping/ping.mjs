// Unattended queue-drain pinger for the wd-queue-drain Render cron.
//
// Runs once per cron fire: hit the app's /api/wa/ping (which drains the
// outbox + graph wakeups and kicks the self-chaining tick), then exit. Baked
// into a Docker image so the command is a clean exec array with ZERO shell
// quoting - the inline `dockerCommand` string kept being mis-parsed by Render
// (exit 127, "command not found" on the whole string).
//
// Reads two env vars set on the cron service (sync:false, never committed):
//   WD_APP_URL    = https://<app>.run.app   (no trailing slash)
//   WD_PING_TOKEN = the raw webhook token (Owner -> Keys) - NO url/query prefix

const base = (process.env.WD_APP_URL || "").replace(/\/+$/, "");
const token = process.env.WD_PING_TOKEN || "";
const url = `${base}/api/wa/ping?token=${encodeURIComponent(token)}`;

// Never hang the cron: hard-stop after 55s regardless of the request state.
const killer = setTimeout(() => process.exit(0), 55_000);
killer.unref?.();

try {
  const res = await fetch(url, { method: "GET" });
  // Best-effort: log a compact status line for the Render cron logs, never throw.
  console.log(`ping ${res.status} ${new Date().toISOString()}`);
} catch (err) {
  console.log(`ping failed (${(err && err.message) || err}) ${new Date().toISOString()}`);
} finally {
  clearTimeout(killer);
  process.exit(0);
}
