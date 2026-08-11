import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A CAP YOU CAN WALK THROUGH IS NOT A CAP.
//
// `checkDailyLimit` READ a count and returned; the debit was a separate
// `recordApi` call somewhere else entirely - ten of those against five of
// these, so the gate and the debit were not even paired. Every request in a
// concurrent burst saw the same pre-debit number, so a user exceeded any cap by
// the parallelism factor.
//
// INCR is atomic: concurrent callers get DISTINCT totals, so exactly one can be
// the one that crosses the line.

/**
 * Hoisted mocks. `vi.doMock` inside a helper does not reliably apply to the
 * FIRST import in a file, so `vi.mock` with a hoisted holder is the pattern
 * that actually binds.
 *
 * AND THE MOCK MUST BE PROVEN TO HAVE RUN. `usage.ts` reached Redis through
 * `await import("./rival-cache")`, and under `Promise.all` only the FIRST of
 * ten concurrent dynamic imports got the mock - the other nine resolved to the
 * real module, which returns null with no REDIS_URL, so nine callers skipped
 * the reservation entirely. That made the burst look unbounded (a product bug
 * that was not there) while the sibling give-back test passed for the wrong
 * reason: its "counter ends at 1" came from ONE increment, not from one
 * admission plus nine hand-backs. `usage.ts` now imports `hotStateClient`
 * statically, exactly as `budget-cache.ts` does, and `clientCalls` below
 * asserts the mock really served every caller.
 */
const h = vi.hoisted(() => {
  const state = {
    store: new Map<string, number>(),
    expires: [] as string[],
    clientCalls: 0,
    redisOn: true,
    redisThrows: false,
    limit: 1,
    used: 0,
  };
  return { state };
});

vi.mock("./rival-cache", () => ({
  hotStateClient: async () => {
    h.state.clientCalls += 1;
    if (h.state.redisThrows) throw new Error("redis down");
    if (!h.state.redisOn) return null;
    return {
      async incr(key: string) {
        const n = (h.state.store.get(key) ?? 0) + 1;
        h.state.store.set(key, n);
        return n;
      },
      async decr(key: string) {
        const n = (h.state.store.get(key) ?? 0) - 1;
        h.state.store.set(key, n);
        return n;
      },
      async expire(key: string) {
        h.state.expires.push(key);
        return 1;
      },
    };
  },
}));

vi.mock("./runtime-config", () => ({
  // The cap itself. LIMIT_AI_PER_DAY defaults to 120, so a burst test against
  // the default would pass vacuously - every caller is genuinely under it.
  getConfig: async (name: string) =>
    name === "SCALE_MODE" ? undefined : String(h.state.limit),
  getConfigStrict: async () => ({ value: undefined }),
  sbInsert: async () => true,
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: h.state.used > 0 ? [{ count: h.state.used }] : [] }),
}));

/**
 * The in-process counter lives on `globalThis` (usage.ts:137), so
 * `vi.resetModules()` does NOT clear it and state leaks between tests.
 */
function reset(opts: { redisOn?: boolean; redisThrows?: boolean; limit?: number } = {}) {
  h.state.store = new Map();
  h.state.expires = [];
  h.state.clientCalls = 0;
  h.state.redisOn = opts.redisOn ?? true;
  h.state.redisThrows = opts.redisThrows ?? false;
  h.state.limit = opts.limit ?? 1;
  h.state.used = 0;
  (globalThis as { __wheeldeal_limits__?: Map<string, unknown> }).__wheeldeal_limits__ =
    new Map();
}

async function usage() {
  return await import("./usage");
}

describe("the reservation is atomic, so a burst cannot walk through", () => {
  beforeEach(() => reset());

  it("REPRODUCTION: N concurrent gates against a limit of 1 admit exactly one", async () => {
    const { checkDailyLimit } = await usage();
    // Ten requests land at once, as a burst of shop replies does.
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY")
      )
    );
    // Every caller must have REACHED the reservation. Without this, a caller
    // that silently skipped Redis reads as "admitted" and the test passes while
    // measuring nothing.
    expect(h.state.clientCalls, "all ten must consult the atomic gate").toBe(10);
    // The Postgres read says 0 used to all ten - it is a snapshot taken before
    // anyone debits. Only the atomic INCR can separate them.
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(1);
  });

  it("a refusal hands its unit BACK, so a burst cannot lock out the whole day", async () => {
    const { checkDailyLimit } = await usage();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY")
      )
    );
    // Ten increments happened, so a counter of 1 can only mean nine hand-backs.
    expect(h.state.clientCalls).toBe(10);
    const key = [...h.state.store.keys()].find((k) => k.startsWith("usage:ai:"));
    expect(h.state.store.get(key!)).toBe(1);
  });

  it("the TTL is set once, on the first increment of the day", async () => {
    // Re-arming it on later traffic would push the window forward and the
    // counter would never expire for an active user.
    const { checkDailyLimit } = await usage();
    await checkDailyLimit("x", "t@example.com", "LIMIT_AI_PER_DAY");
    await checkDailyLimit("x", "t@example.com", "LIMIT_AI_PER_DAY");
    expect(h.state.expires).toHaveLength(1);
  });

  it("the key is scoped per kind, per user, per day", async () => {
    const { checkDailyLimit } = await usage();
    await checkDailyLimit("ai", "a@example.com", "LIMIT_AI_PER_DAY");
    await checkDailyLimit("ai", "b@example.com", "LIMIT_AI_PER_DAY");
    // Two users must not share a counter.
    expect([...h.state.store.keys()]).toHaveLength(2);
    expect(
      [...h.state.store.keys()].every((k) => /^usage:ai:[^:]+:\d{4}-\d{2}-\d{2}$/.test(k))
    ).toBe(true);
  });

  it("`reserve: false` PEEKS - the AI scope reserves per model call instead", async () => {
    // Taking a unit here as well would bill a turn that made no model call.
    const { checkDailyLimit } = await usage();
    await checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY", { reserve: false });
    expect(h.state.store.size).toBe(0);
  });
});

describe("without Redis, the defect is UNFIXED - and says so", () => {
  it("REPRODUCTION: a burst still walks past the cap", async () => {
    // Limit 5, ten simultaneous callers. WITH Redis exactly five are admitted;
    // without it, the Postgres snapshot says 0-used to everyone who reads
    // before anyone writes.
    //
    // The in-process `counters()` map catches SOME of them - it is a
    // per-instance mitigation that has always been there - so this asserts the
    // honest thing: more than one gets through, and the number depends on
    // interleaving rather than on the cap. Across two Cloud Run instances even
    // that mitigation is absent.
    reset({ redisOn: false, limit: 5 });
    const { checkDailyLimit } = await usage();
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY")
      )
    );
    expect(verdicts.filter((v) => v.allowed).length).toBeGreaterThan(1);
  });

  it("...whereas WITH Redis the same burst admits exactly the cap", async () => {
    reset({ limit: 5 });
    const { checkDailyLimit } = await usage();
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY")
      )
    );
    expect(h.state.clientCalls).toBe(10);
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
  });

  it("and the file states that, rather than implying it is solved", () => {
    const raw = readFileSync(join(process.cwd(), "src/lib/usage.ts"), "utf8");
    expect(raw).toMatch(/WITHOUT REDIS THIS IS A NO-OP/);
    expect(raw).toMatch(/has NOT had this defect fixed/);
  });

  it("a Redis outage degrades to the Postgres path, never to a refusal", async () => {
    reset({ redisThrows: true, limit: 5 });
    const { checkDailyLimit } = await usage();
    const v = await checkDailyLimit("ai", "t@example.com", "LIMIT_AI_PER_DAY");
    expect(v.allowed).toBe(true);
  });
});

describe("REFUTED: the WhatsApp volume caps did not need this", () => {
  // The plan called for the same treatment on the WA caps, where an overshoot
  // is a banned number rather than a bill. Reading the code, it is not
  // warranted, and adding a second mechanism that changes nothing would be
  // worse than not adding it - so the reasoning is recorded here instead.
  //
  // The volume cap in guardOutbound IS a read-then-compare. But it is not what
  // bounds velocity: `claimSendSlots` does, via `sbInsertClaim` - an atomic
  // unique-constraint insert - on a TIME-BUCKET slot. Cold intros claim a
  // 12s min-gap bucket per sender; the reply lane buckets per recipient but
  // carries `fleetGapSeconds`, described in its own signature as "an ATOMIC
  // per-sender cap on the TOTAL reply velocity across all shops".
  //
  // So sends for one sender are already serialized by an atomic claim, and two
  // concurrent volume-cap reads cannot both proceed. The residual window is a
  // send whose `whatsapp_messages` row has not landed before the NEXT send 12
  // seconds later - which would overshoot by at most one message, and only on a
  // database slower than the gap.

  it("the gap slot really is claimed atomically, not merely read", () => {
    const pacing = readCode("src/lib/wa/pacing.ts");
    expect(pacing).toMatch(/sbInsertClaim\("wa_send_claims"/);
    expect(pacing).toMatch(/slot_key: recipientSlotFor\(recipientBucket\)/);
  });

  it("the reply lane carries an atomic per-sender fleet gap", () => {
    const pacing = readFileSync(join(process.cwd(), "src/lib/wa/pacing.ts"), "utf8");
    expect(pacing).toMatch(/ATOMIC per-sender cap on the TOTAL reply/);
    expect(readCode("src/lib/wa-guard.ts")).toMatch(/fleetGapSeconds/);
  });

  it("the cold min-gap is large enough for the durable write to land", () => {
    expect(readCode("src/lib/wa-guard.ts")).toMatch(/min_gap_seconds: 12,/);
  });

  it("...and the volume-cap read still fails CLOSED, which is the real guarantee", () => {
    // An unreadable send history holds automated sends rather than counting as
    // "0 sent today" - the outage mode that would actually get a number banned.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const sentRes = await sbSelectStrict</);
  });
});
