import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// AN UNKNOWN INTRODUCTIONS BUDGET WAS TREATED AS AN UNLIMITED ONE, TWICE.
//
// The anti-ban engine's whole job is to bound how many brand-new shops a
// traveller's PERSONAL WhatsApp number introduces itself to per rolling window.
// `introductionsInWindow` was already careful about this: on an unreadable
// Postgres read it answers `count: Infinity, entries: [], unreadable: true`, so
// the batch in front of it is treated as at cap. That part works.
//
// Both of its consumers then threw the answer away.
//
//   1. /api/outreach/mass fell back to `remaining: 99` - three to ten times any
//      plan's real cap - and never once read `budget.unreadable`, the flag whose
//      entire documented purpose is to say "remaining is 0 defensively, not
//      because the allowance is spent".
//
//   2. outreach.worker seeded the Redis mirror UNCONDITIONALLY from that same
//      read. `seedIntroWindow` DELs the sorted set and stamps a `:live` marker
//      for windowHours*2. So the next batch's `introUsage` took the fast path,
//      found a live-and-empty mirror, reported 0 used, and granted the FULL cold
//      budget - for twice the window, from a read that never succeeded.
//
// The second is the worse of the two, because the damage OUTLIVES the outage: a
// single blip buys hours of unmetered cold outreach after Postgres has come
// back. That sequence is reproduced below against the real mirror.

// ---------------------------------------------------------------------------
// in-memory ioredis fake (same shape as budget-cache.test.ts)
// ---------------------------------------------------------------------------
class FakeRedis {
  str = new Map<string, string>();
  z = new Map<string, Map<string, number>>();
  on() {}
  async set(key: string, val: string, ...args: (string | number)[]) {
    const nx = args.map(String).includes("NX");
    if (nx && (this.str.has(key) || this.z.has(key))) return null;
    this.str.set(key, val);
    return "OK";
  }
  async exists(key: string) {
    return this.str.has(key) || this.z.has(key) ? 1 : 0;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.str.delete(k)) n++;
      if (this.z.delete(k)) n++;
    }
    return n;
  }
  async zadd(key: string, score: string, member: string) {
    let m = this.z.get(key);
    if (!m) this.z.set(key, (m = new Map()));
    m.set(member, Number(score));
    return 1;
  }
  async zremrangebyscore(key: string, min: string | number, max: string | number) {
    const m = this.z.get(key);
    if (!m) return 0;
    const lo = Number(min);
    const hi = Number(max);
    let n = 0;
    for (const [member, score] of [...m]) {
      if (score >= lo && score <= hi) {
        m.delete(member);
        n++;
      }
    }
    return n;
  }
  async zcard(key: string) {
    return this.z.get(key)?.size ?? 0;
  }
  async expire() {
    return 1;
  }
  async publish() {
    return 0;
  }
}

let fake: FakeRedis;
vi.mock("ioredis", () => ({
  default: class {
    constructor() {
      return fake;
    }
  },
}));

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://fake");
  fake = new FakeRedis();
  vi.resetModules();
});

const CAP = 10;
const WINDOW_H = 6;

/**
 * The worker's batch gate, replicated. It lives inside a BullMQ handler in
 * services/workers, which imports through `@wheeldeal/*` - aliases this harness
 * does not resolve - so the DECISION is executed here against the real mirror
 * and the source assertions at the bottom pin that the worker still makes it.
 */
async function batchGate(
  b: typeof import("./budget-cache"),
  email: string,
  window: { count: number; entries: { toNumber: string; atMs: number }[]; unreadable?: boolean },
  opts: { guarded: boolean }
): Promise<{ remaining: number; unknown: boolean }> {
  let remaining = await b
    .introUsage(email, WINDOW_H)
    .then((used) => (used === null ? null : Math.max(0, CAP - used)));
  let unknown = false;
  if (remaining === null) {
    if (opts.guarded) {
      if (window.unreadable) unknown = true;
      else await b.seedIntroWindow(email, WINDOW_H, window.entries);
    } else {
      // The shipped behaviour: seed no matter what the read said.
      await b.seedIntroWindow(email, WINDOW_H, window.entries);
    }
    remaining = Math.max(0, CAP - window.count);
  }
  return { remaining, unknown };
}

const OUTAGE = { count: Number.POSITIVE_INFINITY, entries: [], unreadable: true };
const HEALTHY = {
  count: 2,
  entries: [
    { toNumber: "111", atMs: Date.now() },
    { toNumber: "222", atMs: Date.now() },
  ],
};

describe("REPRODUCTION: a blind batch poisoned the NEXT batch's budget", () => {
  it("seeding from an unreadable window grants the full cold cap afterwards", async () => {
    const b = await import("./budget-cache");
    const email = "traveller@example.com";

    // Batch 1 during the outage: correctly gets nothing.
    const first = await batchGate(b, email, OUTAGE, { guarded: false });
    expect(first.remaining).toBe(0);

    // ...but the mirror is now LIVE and EMPTY. Postgres is irrelevant from here.
    expect(
      await b.introUsage(email, WINDOW_H),
      "the mirror answers a confident zero built from a read that failed"
    ).toBe(0);

    // Batch 2, seconds later, never consults Postgres again: full cold budget.
    const second = await batchGate(b, email, HEALTHY, { guarded: false });
    expect(
      second.remaining,
      "one Supabase blip bought the whole cold cap, unmetered"
    ).toBe(CAP);
  });

  it("the fix: an unreadable window leaves the mirror untouched and the batch waits", async () => {
    const b = await import("./budget-cache");
    const email = "traveller@example.com";

    const first = await batchGate(b, email, OUTAGE, { guarded: true });
    expect(first.remaining).toBe(0);
    expect(first.unknown, "the caller must be able to tell 'spent' from 'unknown'").toBe(true);

    // Nothing was written, so the next batch is forced back to the authority.
    expect(
      await b.introUsage(email, WINDOW_H),
      "an unseeded mirror is the only honest state after a failed read"
    ).toBeNull();

    // And when Postgres recovers, the real usage is what bounds the batch.
    const second = await batchGate(b, email, HEALTHY, { guarded: true });
    expect(second.remaining).toBe(CAP - 2);
    expect(second.unknown).toBe(false);
    expect(await b.introUsage(email, WINDOW_H)).toBe(2);
  });

  it("a HEALTHY empty window still seeds - a fresh traveller is not an outage", async () => {
    const b = await import("./budget-cache");
    const email = "new@example.com";
    const gate = await batchGate(b, email, { count: 0, entries: [] }, { guarded: true });
    expect(gate.remaining).toBe(CAP);
    expect(gate.unknown).toBe(false);
    // Genuinely zero introductions: the mirror is seeded and authoritative.
    expect(await b.introUsage(email, WINDOW_H)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The two consumers still make the decision above.
// ---------------------------------------------------------------------------

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the worker's gate", () => {
  const worker = readCode("services/workers/src/outreach.worker.ts");

  it("never seeds the mirror from an unreadable window", () => {
    expect(worker).toMatch(/if \(win\.unreadable\) budgetUnknown = true;/);
    expect(worker).toMatch(/else await seedIntroWindow\(/);
    // The unconditional call is what caused this - it must not come back.
    expect(worker).not.toMatch(/^\s*await seedIntroWindow\(userEmail/m);
  });

  it("REGRESSION: the throwing fallback no longer hands out the whole cap", () => {
    expect(
      worker,
      "newContactBudget's catch used to resolve to cap.newContacts - the full cold budget"
    ).not.toMatch(/newContactBudget\(userEmail, plan\)\.catch\(\(\) => \(\{\s*remaining: cap\.newContacts/);
    expect(worker).toMatch(/budget\.unreadable \? 0 : budget\.remaining/);
  });

  it("an unknown budget retries the job instead of reporting a phantom completion", () => {
    // `remaining: 0` alone would fall into the "no budget - nothing fanned out"
    // branch, which marks the campaign COMPLETED. A campaign that contacted
    // nobody is not complete; batch jobs carry 3 attempts for exactly this.
    expect(worker).toMatch(/if \(budgetUnknown\) \{/);
    expect(worker).toMatch(/throw new Error\("intro budget unreadable"\)/);
    expect(worker.indexOf("if (budgetUnknown) {")).toBeLessThan(
      worker.indexOf('"outreach batch has no budget - nothing fanned out"')
    );
  });
});

describe("the mass-bargain route's click-time budget", () => {
  const route = readCode("src/app/api/outreach/mass/route.ts");

  it("REGRESSION: the 99-introduction fallback is gone", () => {
    expect(route).not.toMatch(/remaining: 99/);
  });

  it("reads the unreadable flag it was ignoring", () => {
    expect(route).toMatch(/budgetUnreadable/);
    expect(route).toMatch(/newIntrosLeft = budgetUnreadable \? 0 : budget\.remaining/);
  });

  it("tells the traveller 'checking', not 'you have used your allowance'", () => {
    expect(route).toMatch(/checking your introductions allowance/);
  });
});

describe("the source of the flag still fails closed", () => {
  it("introductionsInWindow answers Infinity + unreadable on an outage", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(
      /count: Number\.POSITIVE_INFINITY, oldestAsc: \[\], entries: \[\], unreadable: true/
    );
  });

  it("newContactBudget propagates it rather than absorbing it", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/unreadable: unreadable \|\| Boolean\(meters\?\.unreadable\)/);
  });
});
