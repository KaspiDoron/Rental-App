import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

type SelectResult = { rows: unknown[] } | { error: "missing" | "unavailable" };
let selectResults: Record<string, SelectResult> = {};
let inserts: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = [];
let selectCalls = 0;

vi.mock("../runtime-config", () => ({
  // The real one. A stub that just returned the input would let a raw "+00:00"
  // through here while 400ing in production - the exact gap this export closes.
  pgTimestamp: (v: string | number | Date) =>
    encodeURIComponent(new Date(v as string).toISOString()),
  sbSelectStrict: async (table: string) => {
    selectCalls++;
    return selectResults[table] ?? { rows: [] };
  },
  sbInsert: async (table: string, rows: Record<string, unknown>[], onConflict?: string) => {
    inserts.push({ table, rows, onConflict });
    return true;
  },
}));

import {
  aggregate,
  bucketStart,
  rollupBucket,
  riskReport,
  BUCKET_MS,
  ROLLUP_ROW_CAP,
} from "./risk-rollup";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const NOW = 1_800_003_600_000; // an exact hour boundary plus change

beforeEach(() => {
  selectResults = {};
  inserts = [];
  selectCalls = 0;
});

// A DASHBOARD THAT BECOMES THE LOAD IT MONITORS.
//
// /api/activity costs ~21 Supabase round trips per tick plus two awaited
// eight-second WhatsApp drains before it reads anything. A live fan-out risk
// monitor at fleet scale is that, multiplied by the fleet. So the read path
// touches only the hourly rollup.

describe("aggregation", () => {
  it("counts by kind and distinct accounts", () => {
    const out = aggregate(
      [
        { sender_key: "a", kind: "intro_sent" },
        { sender_key: "a", kind: "intro_sent" },
        { sender_key: "b", kind: "intro_answered" },
      ],
      { truncated: false }
    );
    expect(out.counts.intro_sent).toBe(2);
    expect(out.counts.intro_answered).toBe(1);
    expect(out.accounts).toBe(2);
  });

  it("ignores a kind outside the vocabulary rather than inventing a bucket", () => {
    const out = aggregate([{ sender_key: "a", kind: "made_up" }], { truncated: false });
    expect(Object.keys(out.counts)).toHaveLength(0);
    // The account still counts - it did something, we just cannot classify it.
    expect(out.accounts).toBe(1);
  });

  it("E9: a truncated bucket carries the marker WITH its numbers", () => {
    // A count that silently stopped at the cap and a count that genuinely ended
    // there are different facts, and only one is safe to divide by.
    expect(aggregate([], { truncated: true }).truncated_signals).toEqual(["events"]);
    expect(aggregate([], { truncated: false }).truncated_signals).toEqual([]);
  });
});

describe("AN UNREADABLE HOUR IS WRITTEN AS DARK, NOT SKIPPED", () => {
  it("a missing table still produces a bucket, marked dark", async () => {
    // Skipping is the tempting choice - it feels conservative - and it leaves a
    // gap the panel cannot tell apart from an hour in which nothing happened.
    // "Nothing happened" is exactly what a dead sensor looks like.
    selectResults["wa_risk_events"] = { error: "missing" };
    const snap = (await rollupBucket(NOW))!;
    // The EVENTS sensor's darkness, named. Containment rather than equality
    // since W-18: the deaf-session detector is a second, independent sensor
    // that reports its own darkness into the same array, and asserting the
    // whole array would make adding an honest sensor look like a regression.
    expect(snap.dark_signals).toContain("events:missing");
    expect(snap.dark_signals).not.toContain("events:unavailable");
    expect(inserts[0].table).toBe("wa_risk_snapshots");
    expect(inserts[0].rows[0].dark_signals).toContain("events:missing");
  });

  it("an outage is distinguishable from a missing table", async () => {
    selectResults["wa_risk_events"] = { error: "unavailable" };
    const signals = (await rollupBucket(NOW))!.dark_signals;
    expect(signals).toContain("events:unavailable");
    expect(signals).not.toContain("events:missing");
  });

  it("one dark sensor never masks another", async () => {
    // Both sensors are out here: the event table is unreadable AND there is no
    // fleet reading. Two independent facts, both named. A design that kept one
    // "the" dark reason would silently drop whichever lost the race.
    selectResults["wa_risk_events"] = { error: "unavailable" };
    const signals = (await rollupBucket(NOW))!.dark_signals;
    expect(signals).toContain("events:unavailable");
    expect(signals.some((s) => s.startsWith("deaf:"))).toBe(true);
  });

  it("rolls up the hour that just CLOSED, never the live one", async () => {
    // A partially-elapsed hour written as complete would read as a collapse in
    // activity every single time the job runs.
    const snap = (await rollupBucket(NOW))!;
    expect(Date.parse(snap.bucket)).toBe(bucketStart(NOW) - BUCKET_MS);
  });

  it("upserts on the bucket, so a re-run corrects rather than duplicates", async () => {
    await rollupBucket(NOW);
    expect(inserts[0].onConflict).toBe("bucket");
  });

  it("marks truncation when the row cap is reached", async () => {
    selectResults["wa_risk_events"] = {
      rows: Array.from({ length: ROLLUP_ROW_CAP }, () => ({ sender_key: "a", kind: "intro_sent" })),
    };
    expect((await rollupBucket(NOW))!.truncated_signals).toEqual(["events"]);
  });
});

describe("the report reads ONLY the rollup", () => {
  it("one Supabase round trip, whatever the fleet size", async () => {
    selectResults["wa_risk_snapshots"] = { rows: [] };
    await riskReport(NOW);
    expect(selectCalls).toBe(1);
  });

  it("an unreadable rollup is dark, with zeroes that are explicitly not data", async () => {
    selectResults["wa_risk_snapshots"] = { error: "unavailable" };
    const r = await riskReport(NOW);
    expect(r.verdict).toBe("dark");
    expect(r.dark).toEqual(["snapshots:unavailable"]);
    expect(r.stale).toBe(true);
  });

  it("sums each axis across the window", async () => {
    selectResults["wa_risk_snapshots"] = {
      rows: [
        {
          bucket: new Date(bucketStart(NOW) - BUCKET_MS).toISOString(),
          accounts: 3,
          counts: { intro_sent: 10, intro_answered: 4, session_logged_out: 1 },
          dark_signals: [],
          truncated_signals: [],
        },
        {
          bucket: new Date(bucketStart(NOW) - 2 * BUCKET_MS).toISOString(),
          accounts: 2,
          counts: { intro_sent: 5, delivery_receipt: 7 },
          dark_signals: [],
          truncated_signals: [],
        },
      ],
    };
    const r = await riskReport(NOW);
    expect(r.velocity.intros).toBe(15);
    expect(r.velocity.answered).toBe(4);
    expect(r.client.logouts).toBe(1);
    expect(r.meter.delivered).toBe(7);
  });

  it("E8: a stale rollup darkens the verdict even when every count looks fine", async () => {
    // If the writer stopped, every figure on the page is stale by an unknown
    // amount. A screen of stale numbers with no indication is strictly more
    // dangerous than an empty one.
    selectResults["wa_risk_snapshots"] = {
      rows: [
        {
          bucket: new Date(bucketStart(NOW) - 10 * BUCKET_MS).toISOString(),
          accounts: 1,
          counts: { intro_sent: 3 },
          dark_signals: [],
          truncated_signals: [],
        },
      ],
    };
    const r = await riskReport(NOW);
    expect(r.stale).toBe(true);
    expect(r.verdict).toBe("dark");
    expect(r.staleHours).toBeGreaterThanOrEqual(9);
  });

  it("THE VERDICT CAN NEVER AVERAGE ITS WAY BACK TO GREEN", async () => {
    // A dark hour inside an otherwise healthy window still darkens the window.
    // Arithmetic in front of the fail-green bug is still the fail-green bug.
    selectResults["wa_risk_snapshots"] = {
      rows: [
        {
          bucket: new Date(bucketStart(NOW) - BUCKET_MS).toISOString(),
          accounts: 5,
          counts: { intro_sent: 40, intro_answered: 20 },
          dark_signals: [],
          truncated_signals: [],
        },
        {
          bucket: new Date(bucketStart(NOW) - 2 * BUCKET_MS).toISOString(),
          accounts: 0,
          counts: {},
          dark_signals: ["events:unavailable"],
          truncated_signals: [],
        },
      ],
    };
    const r = await riskReport(NOW);
    expect(r.dark).toEqual(["events:unavailable"]);
    expect(r.verdict).toBe("dark");
  });

  it("a confirmed restriction outranks everything", async () => {
    selectResults["wa_risk_snapshots"] = {
      rows: [
        {
          bucket: new Date(bucketStart(NOW) - BUCKET_MS).toISOString(),
          accounts: 1,
          counts: { restriction_confirmed: 1 },
          dark_signals: [],
          truncated_signals: [],
        },
      ],
    };
    expect((await riskReport(NOW)).verdict).toBe("critical");
  });

  it("no buckets at all is EMPTY plus stale - not a healthy zero", async () => {
    selectResults["wa_risk_snapshots"] = { rows: [] };
    const r = await riskReport(NOW);
    expect(r.stale).toBe(true);
    expect(r.staleHours).toBeNull();
    expect(r.verdict).toBe("dark");
  });
});

describe("the staleness rule is imported, not re-implemented", () => {
  it("reuses rollupStale from the fail-dark contract", () => {
    // A second staleness rule is how one surface calls an hour fresh while
    // another calls it dark.
    const code = readCode("src/lib/wa/risk-rollup.ts");
    expect(code).toMatch(/rollupStale/);
    expect(code).not.toMatch(/function snapshotStale/);
  });
});

describe("the panel's non-negotiable ordering", () => {
  const panel = readCode("src/components/admin/BanRiskPanel.tsx");
  const route = readCode("src/app/api/admin/ban-risk/route.ts");

  it("meter integrity renders BEFORE the axes", () => {
    const meters = panel.indexOf("Meter integrity");
    const velocity = panel.indexOf("Velocity - scoped");
    const client = panel.indexOf("Client detection");
    expect(meters).toBeGreaterThan(-1);
    expect(meters).toBeLessThan(velocity);
    expect(velocity).toBeLessThan(client);
  });

  it("dark meters visibly de-emphasise everything below them", () => {
    expect(panel).toMatch(/Meters unverified/);
    expect(panel).toMatch(/metersDark \? "opacity-60" : ""/);
  });

  it("THE TWO AXES ARE NEVER COMBINED INTO ONE SCORE", () => {
    // Axis 2 fires on reply-only accounts with zero sends. A blend would hide
    // the worse of the two behind the better one.
    expect(panel).not.toMatch(/riskScore|combinedScore|overallRisk/i);
    expect(panel).toMatch(/report\.velocity\./);
    expect(panel).toMatch(/report\.client\./);
  });

  it("E4: no ratio below the sample floor, and the floor is IMPORTED", () => {
    // A panel that picked its own threshold would be free to render a reply
    // rate from two introductions. The rule lives once, in the fail-dark
    // contract, and is reused here.
    expect(panel).toMatch(/hasEnoughSample\(report\.velocity\.intros\)/);
    expect(panel).toMatch(/from "@\/lib\/wa\/risk-verdict"/);
    expect(panel).toMatch(/too small a sample/i);
  });

  it("an unreadable fleet is NOT an empty fleet", () => {
    expect(panel).toMatch(/fleet === null/);
    expect(panel).toMatch(/not an empty fleet/);
  });

  it("unknown renders as a dash, never as zero", () => {
    expect(panel).toMatch(/&mdash;/);
    expect(panel).toMatch(/if \(v === null\)/);
  });

  it("dark has its own component so it cannot be styled as a muted ok", () => {
    expect(panel).toMatch(/function DarkBadge/);
  });

  it("the footer states plainly that nothing here reduces ban probability", () => {
    expect(route).toMatch(/shortens the time between WhatsApp pushing back and you knowing/);
    expect(panel).toMatch(/\{data\.disclaimer\}/);
  });

  it("the route is management-gated on both verbs", () => {
    const gates = route.match(/requireManagement\(\)/g) ?? [];
    expect(gates.length).toBe(2);
    expect(route).toMatch(/status: 403/);
  });

  it("mobile first: two columns at 320px, no table", () => {
    expect(panel).toMatch(/grid-cols-2/);
    expect(panel).not.toMatch(/<table/);
  });
});
