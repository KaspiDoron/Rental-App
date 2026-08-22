import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, wave E - the cost and capacity leaks that bite at 50 users.

describe("the Evolution database stops filling", () => {
  const y = read("render.yaml");

  it("THE 17-DAY CLOCK: the prune cron is enabled, daily, at 7 days", () => {
    // 50 users x ~90 messages/hunt/day is ~9-15 MB/day into a 256 MB database.
    // The old block was COMMENTED OUT, and even enabled it was monthly at 30
    // days - it would have fired for the first time after the disk was full.
    expect(y).toMatch(/^\s{2}- type: cron\s*$/m);
    expect(y).toMatch(/name: wd-evo-prune/);
    expect(y).toMatch(/schedule: "0 4 \* \* \*"/);
    expect(y).toMatch(/key: PRUNE_DAYS\s*\n\s*value: "7"/);
    expect(y).not.toMatch(/#\s*name: wd-evo-prune/);
  });

  it("MessageUpdate is no longer persisted - nothing reads that table", () => {
    // Receipts reach us as webhook EVENTS. The table was 2-3 rows per outbound
    // written purely to be pruned later, on the plan whose disk is the limit.
    expect(y).toMatch(/DATABASE_SAVE_DATA_MESSAGE_UPDATE\s*\n\s*value: "false"/);
  });

  it("the prune still degrades to a no-op on a renamed table", () => {
    const sh = read("deploy/prune/prune.sh");
    expect(sh).toMatch(/to_regclass\('public\."Message"'\) is not null/);
    expect(sh).toMatch(/ON_ERROR_STOP=0/);
  });
});

describe("the billed photo proxy is metered and bounded", () => {
  const route = read("src/app/api/photo/route.ts");

  it("THE OPEN TAP: it is rate limited per IP", () => {
    expect(route).toMatch(/rateLimit\("photo", clientIp\(req\), 300, 3600\)/);
    expect(route).toMatch(/return fail\(429/);
  });

  it("...and it finally records what it spent", () => {
    // The `photo` quota existed in usage.ts and nothing wrote to it, so the
    // panel reporting Google spend read zero for this route forever.
    expect(route).toMatch(/recordApi\("photo"\)/);
  });

  it("success only - a 502 from Google is not a billed call", () => {
    const meterAt = route.indexOf(`void recordApi("photo")`);
    const bodyGuard = route.indexOf('if (!res || !res.body)');
    expect(bodyGuard).toBeGreaterThan(0);
    expect(meterAt, "the meter sits after the failure guards").toBeGreaterThan(bodyGuard);
  });

  it("it stays UNAUTHENTICATED - these render on the public marketing surface", () => {
    expect(route).not.toMatch(/requireSession|getSession\(\)/);
  });
});

describe("Cloud Run stops holding slots it cannot use", () => {
  const wf = read(".github/workflows/deploy-gcp.yml");

  it("THE PHANTOM GUARD: the real ceiling is 90s, not 300", () => {
    // `export const maxDuration` is Vercel-only and inert on a standalone
    // server, so the route comments describe a guard that does not exist.
    expect(wf).toMatch(/--timeout 90/);
    expect(wf).not.toMatch(/--timeout 300/);
  });

  it("drain-carrying polls hold 3s, not 8s, and it is applied twice", () => {
    for (const p of ["src/app/api/activity/route.ts", "src/app/api/replies/route.ts"]) {
      expect(read(p), p).toMatch(/const DRAIN_BUDGET_MS = 3_000;/);
      expect(read(p), p).not.toMatch(/const DRAIN_BUDGET_MS = 8_000;/);
    }
  });

  it("the image registry is bounded, and a policy failure never fails a deploy", () => {
    expect(wf).toMatch(/set-cleanup-policies/);
    expect(wf).toMatch(/"keepCount": 5/);
    expect(wf).toMatch(/continue-on-error: true/);
  });
});
