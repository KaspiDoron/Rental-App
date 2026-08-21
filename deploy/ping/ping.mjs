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
//
// EXIT CODES ARE THE ALARM (owner report 6, J5). This exited 0 on every
// outcome, so a deleted env var, a rotated token or a decommissioned URL
// looked exactly like success and the drain silently died - the failure
// class the 17-Aug health-check email came from. Render emails on a failed
// cron run, so: CONFIG-class failures (missing env, 401/403/404 - things a
// human must fix, that will fail identically next run) exit 1 and page the
// owner; TRANSIENT failures (5xx, network refusal, timeout) exit 0 - the
// next fire retries them and an email would only be noise.

const base = (process.env.WD_APP_URL || "").replace(/\/+$/, "");
const token = process.env.WD_PING_TOKEN || "";

if (!base || !token) {
  console.log(
    `ping misconfigured (WD_APP_URL ${base ? "set" : "MISSING"}, WD_PING_TOKEN ${
      token ? "set" : "MISSING"
    }) ${new Date().toISOString()}`
  );
  process.exit(1); // config-class: identical failure next run - page the owner
}

const url = `${base}/api/wa/ping?token=${encodeURIComponent(token)}`;

// Never hang the cron: hard-stop after 55s regardless of the request state.
// A hang is transient-class (exit 0) - the next fire retries.
const killer = setTimeout(() => process.exit(0), 55_000);
killer.unref?.();

let code = 0;
try {
  const res = await fetch(url, { method: "GET" });
  console.log(`ping ${res.status} ${new Date().toISOString()}`);
  // 401/403 = the token no longer matches; 404 = the URL points at nothing.
  // Neither heals on retry - that is the owner's email to get.
  if (res.status === 401 || res.status === 403 || res.status === 404) code = 1;
} catch (err) {
  // Network-level failure: usually the app cold-starting or a blip - retry
  // next fire, no alarm.
  console.log(`ping failed (${(err && err.message) || err}) ${new Date().toISOString()}`);
} finally {
  clearTimeout(killer);
  process.exit(code);
}
