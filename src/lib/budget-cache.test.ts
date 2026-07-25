import { describe, it, expect, beforeEach, vi } from "vitest";

// Module-6 budget engine tested against an in-memory Redis fake. We stub
// REDIS_URL so hotStateClient() builds the mock (REDIS-off behavior is proven
// separately by the "no REDIS_URL" block at the bottom, which runs in a child
// import with the env unset).

// ---- in-memory ioredis fake -----------------------------------------------
class FakeRedis {
  str = new Map<string, string>();
  z = new Map<string, Map<string, number>>();
  h = new Map<string, Map<string, string>>();
  on() {}
  async set(key: string, val: string, ...args: (string | number)[]) {
    const nx = args.map(String).includes("NX");
    if (nx && (this.str.has(key) || this.z.has(key) || this.h.has(key))) return null;
    this.str.set(key, val);
    return "OK";
  }
  async exists(key: string) {
    return this.str.has(key) || this.z.has(key) || this.h.has(key) ? 1 : 0;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.str.delete(k)) n++;
      if (this.z.delete(k)) n++;
      if (this.h.delete(k)) n++;
    }
    return n;
  }
  async incr(key: string) {
    const v = Number(this.str.get(key) ?? "0") + 1;
    this.str.set(key, String(v));
    return v;
  }
  async decr(key: string) {
    const v = Number(this.str.get(key) ?? "0") - 1;
    this.str.set(key, String(v));
    return v;
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
  async hset(key: string, ...fv: (string | number)[]) {
    let m = this.h.get(key);
    if (!m) this.h.set(key, (m = new Map()));
    for (let i = 0; i < fv.length; i += 2) m.set(String(fv[i]), String(fv[i + 1]));
    return 1;
  }
  async hincrby(key: string, field: string, n: number) {
    let m = this.h.get(key);
    if (!m) this.h.set(key, (m = new Map()));
    const v = Number(m.get(field) ?? "0") + n;
    m.set(field, String(v));
    return v;
  }
  async hgetall(key: string) {
    const m = this.h.get(key);
    return m ? Object.fromEntries(m) : {};
  }
  async expire() {
    return 1;
  }
  async publish() {
    return 0;
  }
}

let fake: FakeRedis;
vi.mock("ioredis", () => ({ default: class {
  constructor() {
    return fake;
  }
} }));

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://fake");
  fake = new FakeRedis();
  vi.resetModules();
});

async function load() {
  return await import("./budget-cache");
}

describe("budget-cache key schema", () => {
  it("builds scoped, collision-free keys", async () => {
    const b = await load();
    expect(b.introsKey("a@x.com")).toBe("budget:intros:a@x.com");
    expect(b.introsLiveKey("a@x.com")).toBe("budget:intros:a@x.com:live");
    expect(b.campaignSlotKey("a@x.com")).toBe("budget:campaigns:a@x.com");
    expect(b.campaignHeldKey("a@x.com", "B1")).toBe("budget:campaigns:a@x.com:held:B1");
    expect(b.campaignKey("B1")).toBe("campaign:B1");
  });
});

describe("intro-window mirror", () => {
  it("introUsage is null until seeded, then counts distinct members", async () => {
    const b = await load();
    expect(await b.introUsage("u@x.com", 6)).toBeNull(); // unseeded
    await b.seedIntroWindow("u@x.com", 6, [
      { toNumber: "111", atMs: Date.now() },
      { toNumber: "222", atMs: Date.now() },
    ]);
    expect(await b.introUsage("u@x.com", 6)).toBe(2);
  });

  it("trims members older than the window before counting", async () => {
    const b = await load();
    await b.seedIntroWindow("u@x.com", 6, [
      { toNumber: "fresh", atMs: Date.now() },
      { toNumber: "stale", atMs: Date.now() - 7 * 3600_000 }, // older than 6h
    ]);
    expect(await b.introUsage("u@x.com", 6)).toBe(1);
  });

  it("recordIntro dedups by recipient and is a no-op when unseeded", async () => {
    const b = await load();
    // unseeded: recordIntro must NOT create a partial mirror
    await b.recordIntro("u@x.com", "999", 6);
    expect(await b.introUsage("u@x.com", 6)).toBeNull();
    // seeded: a repeat recipient does not double-count
    await b.seedIntroWindow("u@x.com", 6, [{ toNumber: "111", atMs: Date.now() }]);
    await b.recordIntro("u@x.com", "111", 6);
    await b.recordIntro("u@x.com", "222", 6);
    expect(await b.introUsage("u@x.com", 6)).toBe(2);
  });
});

describe("concurrent-campaign gate", () => {
  it("grants up to the cap, then rejects", async () => {
    const b = await load();
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B1", 2)).toEqual({ ok: true });
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B2", 2)).toEqual({ ok: true });
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B3", 2)).toEqual({ ok: false, active: 2, cap: 2 });
  });

  it("is idempotent per batchId (a retried batch never double-INCRs)", async () => {
    const b = await load();
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B1", 1)).toEqual({ ok: true });
    // same batchId again = retry replay, still ok, counter unchanged
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B1", 1)).toEqual({ ok: true });
    // a DIFFERENT batch is now over the cap of 1
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B2", 1)).toEqual({ ok: false, active: 1, cap: 1 });
  });

  it("release frees a slot and floors at zero (never blocks a user forever)", async () => {
    const b = await load();
    await b.tryAcquireCampaignSlot("u@x.com", "B1", 1);
    await b.releaseCampaignSlot("u@x.com", "B1");
    // slot free again
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B2", 1)).toEqual({ ok: true });
    // a double / unknown release is a no-op and cannot drive the counter negative
    await b.releaseCampaignSlot("u@x.com", "never-held");
    await b.releaseCampaignSlot("u@x.com", "B2");
    await b.releaseCampaignSlot("u@x.com", "B2");
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B3", 1)).toEqual({ ok: true });
  });
});

describe("REDIS_URL off - strict no-op, callers fall back to Postgres", () => {
  it("introUsage / tryAcquireCampaignSlot / completeVendorJob all return null", async () => {
    vi.unstubAllEnvs(); // REDIS_URL unset
    vi.resetModules();
    const b = await import("./budget-cache");
    expect(await b.introUsage("u@x.com", 6)).toBeNull();
    expect(await b.tryAcquireCampaignSlot("u@x.com", "B1", 2)).toBeNull();
    expect(await b.completeVendorJob("B1")).toBeNull();
    expect(await b.readCampaign("B1")).toEqual({});
    // writes never throw
    await b.recordIntro("u@x.com", "111", 6);
    await b.releaseCampaignSlot("u@x.com", "B1");
  });
});

describe("campaign progress hash", () => {
  it("completeVendorJob returns remaining and hits 0 exactly once", async () => {
    const b = await load();
    await b.initCampaign("B1", { userEmail: "u@x.com", plan: "pro", total: 2, skipped: 0 });
    expect(await b.completeVendorJob("B1")).toBe(1);
    expect(await b.completeVendorJob("B1")).toBe(0); // the completion trigger
    expect(await b.completeVendorJob("B1")).toBe(-1); // a replayed job skips (< 0)
  });

  it("bump + state + read reflect the running tallies", async () => {
    const b = await load();
    await b.initCampaign("B1", { userEmail: "u@x.com", plan: "pro", total: 3, skipped: 1 });
    await b.bumpCampaign("B1", "dispatched");
    await b.bumpCampaign("B1", "failed");
    await b.setCampaignState("B1", "completed");
    const h = await b.readCampaign("B1");
    expect(h.dispatched).toBe("1");
    expect(h.failed).toBe("1");
    expect(h.skipped).toBe("1");
    expect(h.state).toBe("completed");
  });
});
