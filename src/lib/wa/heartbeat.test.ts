import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// NOTHING WAS WAKING THE SYSTEM.
//
// A queued message, a strategic wait, a three-minute check-back on a quiet
// thread: each is a row with a due time and no timer behind it. Every drain
// runs inside a request handler - the webhook, the app's own polling - so with
// the owner's phone locked and no shop replying, a due row waits.
//
// The only periodic-drain artifact this repo had was render.yaml's cron, which
// is a Render.com Blueprint resource and does precisely nothing for a service
// running on Cloud Run. The documented fallback was an out-of-repo cron-job.org
// job that PRODUCTION-READINESS.md itself calls a single point of failure
// nobody would notice lapsing. So the honest answer to "what fires a wakeup
// when the app is closed?" was: whatever the owner next taps.

describe("the heartbeat exists in infrastructure, not in a doc", () => {
  const wf = read(".github/workflows/deploy-gcp.yml");

  it("REPRODUCTION: the deploy provisions a Cloud Scheduler job", () => {
    expect(wf).toMatch(/gcloud scheduler jobs create http "\$JOB"/);
    expect(wf).toMatch(/gcloud scheduler jobs update http "\$JOB"/);
  });

  it("it runs every minute and calls the drain endpoint", () => {
    expect(wf).toMatch(/--schedule "\* \* \* \* \*"/);
    expect(wf).toMatch(/TARGET="\$URL\/api\/wa\/ping\?token=\$TOKEN"/);
  });

  it("it authenticates with the token the ping route already accepts", () => {
    // Same derivation as src/lib/wa/webhook-token.ts - no new secret to set,
    // nothing extra for the owner to configure by hand.
    expect(wf).toMatch(/printf 'wd-webhook:%s' "\$SESSION_SECRET" \| sha256sum \| cut -c1-32/);
    const tok = readCode("src/lib/wa/webhook-token.ts");
    expect(tok).toMatch(/wd-webhook:\$\{secret\}/);
    expect(tok).toMatch(/\.slice\(0, 32\)/);
  });

  it("wiring it is idempotent - a redeploy updates rather than duplicates", () => {
    expect(wf).toMatch(/if gcloud scheduler jobs describe "\$JOB"/);
  });

  it("the running revision is stamped so the owner can verify what shipped", () => {
    expect(wf).toMatch(/ENV_VARS="WD_BUILD_SHA=\$IMAGE_TAG"/);
    expect(wf).toMatch(/WD_BUILD_AT=/);
  });
});

describe("a heartbeat that stops must be visible", () => {
  it("every ping leaves a dated mark", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/kind: "cron-ping"/);
  });

  it("and the ping's own tick kick can survive the response too", () => {
    const ping = readCode("src/app/api/wa/ping/route.ts");
    expect(ping).toMatch(/await kickDispatcher\(/);
    expect(ping).not.toMatch(/fetch\(\s*`\$\{new URL\(req\.url\)\.origin\}\/api\/wa\/tick/);
  });

  it("the self-check reports its age and says plainly what a lapse means", () => {
    const info = readCode("src/app/api/admin/deploy-info/route.ts");
    expect(info).toMatch(/kind=eq\.cron-ping/);
    expect(info).toMatch(/HEARTBEAT_STALE_MS/);
    expect(read("src/app/api/admin/deploy-info/route.ts")).toMatch(
      /NOTHING is draining the queue/
    );
  });
});

describe("the self-check answers the questions a field failure raises", () => {
  const info = readCode("src/app/api/admin/deploy-info/route.ts");

  it("what is serving right now", () => {
    expect(info).toMatch(/WD_BUILD_SHA/);
    expect(info).toMatch(/K_REVISION/);
  });

  it("does the database actually have what the fixes need", () => {
    // Each of these degrades SILENTLY to pre-fix behaviour when missing, which
    // is the least debuggable failure this app has.
    expect(info).toMatch(/probe\("wa_send_claims"/);
    expect(info).toMatch(/probe\("wa_outbox", "to_key"\)/);
    expect(info).toMatch(/probe\("searches", "rfq,snapshot"\)/);
    expect(info).toMatch(/probe\("graph_wakeups"/);
  });

  it("can the agents think at all", () => {
    expect(info).toMatch(/configuredProviders\(\)/);
  });

  it("it is owner-gated", () => {
    expect(info).toMatch(/requireManagement\(\)/);
    expect(info).toMatch(/status: 403/);
  });

  it("and it is reachable from the admin screen on a phone", () => {
    const admin = readCode("src/app/admin/page.tsx");
    expect(admin).toMatch(/DeployInfoCard/);
  });
});
