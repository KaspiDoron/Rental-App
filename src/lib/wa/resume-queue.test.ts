import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// The live report: "Why does it take one hour to send those messages?"
//
// Five cold introductions were parked by the session-pause branch of the guard
// (an hour-long hold), the traveller resumed, and the rows kept their hold - so
// the panel said "Agents active" while every queue row said "Paused by you -
// sends in ~64 min". A resume has to RELEASE what the pause parked.

vi.mock("server-only", () => ({}));

interface Row {
  id: number;
  sender_key: string;
  to_number: string;
  not_before: string;
  meta: { reason?: string; kind?: string } | null;
}

const state: { rows: Row[]; failIds: Set<number> } = { rows: [], failIds: new Set() };

vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, query: string) => {
    if (table !== "wa_outbox") return [];
    const sender = decodeURIComponent(/sender_key=eq\.([^&]+)/.exec(query)?.[1] ?? "");
    return state.rows
      .filter((r) => r.sender_key === sender)
      .sort((a, b) => a.not_before.localeCompare(b.not_before));
  },
  sbUpdate: async (table: string, filter: string, values: Record<string, unknown>) => {
    if (table !== "wa_outbox") return false;
    const id = Number(/id=eq\.(\d+)/.exec(filter)?.[1] ?? 0);
    if (state.failIds.has(id)) return false;
    const row = state.rows.find((r) => r.id === id);
    if (!row) return false;
    row.not_before = String(values.not_before);
    row.meta = values.meta as Row["meta"];
    return true;
  },
}));

vi.mock("../wa-guard", () => ({
  getPolicies: async () => ({ min_gap_seconds: 12 }),
}));

const { releasePausedQueue, releasedNotBefore, parkedByPause, RESUMED_REASON } = await import(
  "./resume-queue"
);

const hoursOut = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function seed(rows: Array<Partial<Row> & { id: number; reason?: string }>): void {
  state.rows = rows.map((r) => ({
    id: r.id,
    sender_key: r.sender_key ?? "a@x.com",
    to_number: r.to_number ?? `6681000000${r.id}`,
    not_before: r.not_before ?? hoursOut(1),
    meta: { reason: r.reason ?? "paused by you" },
  }));
}

beforeEach(() => {
  state.rows = [];
  state.failIds = new Set();
});

describe("resuming releases what the pause parked", () => {
  it("pulls every pause-parked row forward instead of leaving it an hour out", async () => {
    seed([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const released = await releasePausedQueue("a@x.com");
    expect(released).toBe(3);
    for (const r of state.rows) {
      expect(Date.parse(r.not_before) - Date.now()).toBeLessThan(60_000);
    }
  });

  it("clears the batch inside minutes, not an hour - ten shops on a 12s ladder", async () => {
    seed(Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })));
    await releasePausedQueue("a@x.com");
    const last = Math.max(...state.rows.map((r) => Date.parse(r.not_before)));
    // The owner's bar: ~10 messages within 15 minutes. The ladder alone puts
    // the last one ~2 min out; the drain's own pacing is what fills the rest.
    expect(last - Date.now()).toBeLessThan(15 * 60_000);
  });

  it("staggers them - a released batch must not leave as one burst", async () => {
    seed([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await releasePausedQueue("a@x.com");
    const times = state.rows.map((r) => Date.parse(r.not_before)).sort((a, b) => a - b);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(12_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(12_000);
  });

  it("leaves holds the resume did NOT lift exactly where they were", async () => {
    const closedAt = hoursOut(9);
    const capAt = hoursOut(2);
    seed([
      { id: 1, reason: "paused by you" },
      { id: 2, reason: "shop is closed now", not_before: closedAt },
      { id: 3, reason: "hourly cap reached (15/h at trust 20)", not_before: capAt },
    ]);
    const released = await releasePausedQueue("a@x.com");
    expect(released).toBe(1);
    expect(state.rows.find((r) => r.id === 2)?.not_before).toBe(closedAt);
    expect(state.rows.find((r) => r.id === 3)?.not_before).toBe(capAt);
  });

  it("never touches another traveller's queue", async () => {
    seed([{ id: 1 }, { id: 2, sender_key: "b@x.com" }]);
    const before = state.rows.find((r) => r.id === 2)?.not_before;
    await releasePausedQueue("a@x.com");
    expect(state.rows.find((r) => r.id === 2)?.not_before).toBe(before);
  });

  it("re-labels a released row honestly - it can no longer read 'Paused by you'", async () => {
    seed([{ id: 1 }]);
    await releasePausedQueue("a@x.com");
    expect(state.rows[0].meta?.reason).toBe(RESUMED_REASON);
    expect(parkedByPause(state.rows[0].meta?.reason)).toBe(false);
  });

  it("keeps the row's other meta - the kind decides its drain lane", async () => {
    state.rows = [
      {
        id: 1,
        sender_key: "a@x.com",
        to_number: "66810000001",
        not_before: hoursOut(1),
        meta: { reason: "paused by you", kind: "rfq" },
      },
    ];
    await releasePausedQueue("a@x.com");
    expect(state.rows[0].meta?.kind).toBe("rfq");
  });

  it("a failed write costs a slower resume, never a lost message", async () => {
    seed([{ id: 1 }, { id: 2 }]);
    state.failIds = new Set([1]);
    const released = await releasePausedQueue("a@x.com");
    expect(released).toBe(1);
    expect(state.rows).toHaveLength(2); // nothing dropped
  });

  it("does nothing at all when there is no pause-parked work", async () => {
    seed([{ id: 1, reason: "human pacing gap" }]);
    expect(await releasePausedQueue("a@x.com")).toBe(0);
  });
});

// Source-level pins for the wiring. There is no unit that can fail if a future
// edit unhooks the release or restores the hour-long hold - the code would just
// quietly go slow again, which is how this shipped in the first place.
describe("the wiring that makes a resume mean something", () => {
  const readCode = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  it("the resume path actually calls the release", () => {
    const code = readCode("src/app/api/session/pause/route.ts");
    expect(code).toMatch(/releasePausedQueue/);
    expect(code).toMatch(/mode === "resume"/);
  });

  it("the pause hold is minutes, not an hour", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    const hold = /jitteredHold\(now,\s*(\d+),\s*(\d+)\)\s*,\s*"paused by you"/.exec(guard);
    expect(hold, "the pause branch must still park with a jittered hold").toBeTruthy();
    expect(Number(hold![1]) + Number(hold![2])).toBeLessThanOrEqual(15);
  });

  it("the kill switch follows the live poll instead of its mount-time read", () => {
    expect(readCode("src/components/AgentKillSwitch.tsx")).toMatch(/serverPaused/);
    expect(readCode("src/app/api/activity/route.ts")).toMatch(/sessionPaused/);
    expect(readCode("src/app/page.tsx")).toMatch(/d\.sessionPaused/);
  });
});

describe("the release ladder", () => {
  it("puts the first row effectively now and paces the rest", () => {
    const now = 1_700_000_000_000;
    expect(Date.parse(releasedNotBefore(0, now, 12)) - now).toBeLessThanOrEqual(10_000);
    expect(Date.parse(releasedNotBefore(4, now, 12)) - now).toBe(5_000 + 4 * 12_000);
  });

  it("survives a zero/negative gap rather than stamping them all together", () => {
    const now = 1_700_000_000_000;
    expect(Date.parse(releasedNotBefore(1, now, 0))).toBeGreaterThan(
      Date.parse(releasedNotBefore(0, now, 0))
    );
  });
});
