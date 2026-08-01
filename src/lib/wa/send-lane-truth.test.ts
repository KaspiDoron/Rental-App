import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { outboxExpired, OUTBOX_MAX_AGE_MS } from "./outbox-policy";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// A SCHEDULER MEETING A THREE-DAY-OLD BACKLOG.
//
// Nothing has ever drained this deployment automatically, so the outbox has only
// ever moved when a human opened the app. Provisioning a cron that calls the
// drain every minute changes what "due" means: every row whose not_before has
// passed becomes eligible at once, however long ago it passed.

describe("REPRODUCTION: 'due' was a floor with no ceiling", () => {
  it("a row overdue by minutes is still perfectly sendable", () => {
    expect(outboxExpired(ago(5 * 60_000), NOW)).toBe(false);
  });

  it("a row overdue by three days is not", () => {
    expect(outboxExpired(ago(3 * 24 * 3600_000), NOW)).toBe(true);
  });

  it("the boundary is the ceiling itself, not near it", () => {
    expect(outboxExpired(ago(OUTBOX_MAX_AGE_MS - 1000), NOW)).toBe(false);
    expect(outboxExpired(ago(OUTBOX_MAX_AGE_MS + 1000), NOW)).toBe(true);
  });

  it("a row due in the FUTURE is never expired", () => {
    expect(outboxExpired(new Date(NOW + 3600_000).toISOString(), NOW)).toBe(false);
  });

  it("an unparseable timestamp is not evidence of age", () => {
    // Guessing "expired" here would silently bin a message over a bad string.
    expect(outboxExpired("not a date", NOW)).toBe(false);
  });

  it("the ceiling clears the longest legitimate pacing hold", () => {
    // The batch deadline clamps a cold batch to the same evening, so nothing
    // the pacer itself schedules can be caught by this.
    expect(OUTBOX_MAX_AGE_MS).toBeGreaterThanOrEqual(4 * 3600_000);
    expect(OUTBOX_MAX_AGE_MS).toBeLessThanOrEqual(12 * 3600_000);
  });
});

describe("REPRODUCTION: the freshness gate cannot catch these, by design", () => {
  it("a cold introduction is exempt from staleness - so age is the ONLY guard", () => {
    // NEVER_STALE is correct: an rfq has no thread to be out of date with, so
    // judgeFreshness would never drop it however old. That is exactly why the
    // absolute ceiling had to exist somewhere else.
    const fresh = readCode("src/lib/wa/freshness-live.ts");
    expect(fresh).toMatch(/const NEVER_STALE = new Set\(\["rfq", "custom", "human-manual"\]\);/);
    expect(fresh).toMatch(/if \(args\.kind && NEVER_STALE\.has\(args\.kind\)\) return FRESH;/);
    expect(outboxExpired(ago(3 * 24 * 3600_000), NOW)).toBe(true);
  });

  it("the drain bins the row instead of sending it, and says so", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/if \(outboxExpired\(cand\.not_before, Date\.now\(\)\)\) \{/);
    expect(guard).toMatch(/kind: "wa-send-expired"/);
    // Completed, not re-parked: a re-park would leave it to expire again forever.
    const block = guard.slice(
      guard.indexOf("if (outboxExpired("),
      guard.indexOf("const cold = isCold(cand);")
    );
    expect(block).toMatch(/completeOutboxRow\(cand\.id\)/);
  });
});

describe("REPRODUCTION: contention and outage shared one counter", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("a pacing loss and a fail-closed error write DIFFERENT kinds", () => {
    // claim-lost: another sender legitimately holds the lane - the system
    // pacing itself, the row retried in seconds.
    // claim-error: the claim table could not be read, so we declined to send.
    // The send lane is down. Reading one number could not tell them apart.
    expect(guard).toMatch(/kind: claim\.kind === "pacing" \? "claim-lost" : "claim-error",/);
  });

  it("both reach the admin surface", () => {
    const health = readCode("src/app/api/admin/health/route.ts");
    expect(health).toMatch(/"claim-lost",/);
    expect(health).toMatch(/"claim-error",/);
    expect(health).toMatch(/"wa-send-expired",/);
  });
});

describe("REPRODUCTION: one limit=500 shared by every counter", () => {
  const health = readCode("src/app/api/admin/health/route.ts");

  it("each kind is counted independently of the others' volume", () => {
    // The old read was `kind=in.(...)&limit=500`, so a chatty kind could fill
    // the budget and leave every other counter reading zero - the numbers that
    // say whether sends are dropping would look best when the system was busiest.
    expect(health).toMatch(/guardKinds\.map\(\(k\) =>/);
    expect(health).toMatch(/kind=eq\.\$\{encodeURIComponent\(k\)\}/);
    // The shared budget is gone: no `kind=in.(...)` read over guardKinds, and
    // no limit anywhere in the block that produces guardCounters. (Other reads
    // in this route are genuinely bounded previews and keep their limits.)
    expect(health).not.toMatch(/kind=in\.\$\{guardKinds/);
    const block = health.slice(
      health.indexOf("const counts = await Promise.all("),
      health.indexOf("const guardCounters")
    );
    expect(block).not.toMatch(/limit=/);
  });

  it("...via an exact count, not a bounded row read", () => {
    const rc = readCode("src/lib/runtime-config.ts");
    expect(rc).toMatch(/export async function sbCount\(/);
    expect(rc).toMatch(/Prefer: "count=exact"/);
    expect(rc).toMatch(/content-range/);
  });
});

describe("REPRODUCTION: the reply path hard-depended on a column newer than some databases", () => {
  const park = readCode("src/lib/wa/park.ts");

  it("park probes for to_key and falls back to to_number", () => {
    // All three uses - delete scope, insert record, existence probe - 400 on a
    // database that has not been migrated. Every agent reply park then fails:
    // a total reply outage whose only trace is a wa-park-failed breadcrumb.
    expect(park).toMatch(/const hasToKey = \(await tableReady\("wa_outbox", "to_key"\)\) === "ready";/);
    expect(park).toMatch(/hasToKey\s*\?\s*`sender_key=eq\./);
    expect(park).toMatch(/to_number=eq\.\$\{encodeURIComponent\(row\.toNumber\)\}/);
  });

  it("...and omits the column from the insert rather than sending a null", () => {
    expect(park).toMatch(/\.\.\.\(hasToKey \? \{ to_key: key \} : \{\}\),/);
  });
});
