import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE CAP GOVERNED NOTHING AT ALL.
//
// Two independent facts, each verified by grep before the fix:
//
//   1. `LIMIT_AI_PER_DAY` was referenced at exactly ONE call site
//      (api/extract-offer). `checkDailyLimit|killSwitchOn` across
//      src/lib/spte/**, src/lib/graph/**, agent-loop.ts, ai.ts and
//      orchestrator.ts returned NOTHING - the negotiation engine, which is
//      where essentially all token spend happens, had no gate of any kind.
//
//   2. That single gate could never fire anyway, because NOTHING ever wrote
//      `recordApi("ai", ...)`. The counter it read was never incremented, so
//      `used` was permanently 0.
//
// So the owner's "AI calls per day" slider governed zero requests while
// reporting that it governed everything. At a paid launch, one traveller with
// forty shops across several rounds each is unbounded spend.
//
// The fix is a scope, not a sprinkle: gating at the ~20 `chat()` call sites is
// exactly how it ended up on one of them.

/** The store is module-level, so each test gets a fresh module. */
async function loadBudget(opts: {
  allowed?: boolean;
  used?: number;
  limit?: number;
  throwOnGate?: boolean;
}) {
  vi.resetModules();
  const debits: Array<{ kind: string; count: number; who?: string }> = [];
  vi.doMock("./usage", () => ({
    checkDailyLimit: async () => {
      if (opts.throwOnGate) throw new Error("boom");
      return {
        allowed: opts.allowed ?? true,
        used: opts.used ?? 0,
        limit: opts.limit ?? 120,
      };
    },
    recordApi: async (kind: string, count: number, who?: string) => {
      debits.push({ kind, count, who });
    },
    // No Redis in unit tests: the atomic half is a no-op and the local
    // allowance is all there is - exactly the documented degraded shape.
    reserveDailyUnitFor: async () => true,
  }));
  const mod = await import("./ai-budget");
  return { ...mod, debits };
}

describe("a turn is billed once, to the person who owns it", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("one read on open and one debit on close, whatever the call count", async () => {
    const { runWithAiBudget, reserveAiCall, debits } = await loadBudget({ allowed: true });
    await runWithAiBudget("t@example.com", async () => {
      // A single engine turn makes several model calls.
      expect(await reserveAiCall()).toBe("ok");
      expect(await reserveAiCall()).toBe("ok");
      expect(await reserveAiCall()).toBe("ok");
    });
    expect(debits).toEqual([{ kind: "ai", count: 3, who: "t@example.com" }]);
  });

  it("a turn that made no model call is not billed at all", async () => {
    const { runWithAiBudget, debits } = await loadBudget({ allowed: true });
    await runWithAiBudget("t@example.com", async () => {});
    expect(debits).toEqual([]);
  });

  it("REPRODUCTION: without a scope, calls are ungoverned - the old behaviour", async () => {
    // Deliberate: an un-migrated path must behave exactly as it does today
    // rather than failing shut on code nobody has wrapped yet.
    const { reserveAiCall } = await loadBudget({ allowed: true });
    expect(await reserveAiCall()).toBe("ungoverned");
  });

  it("an empty identity runs ungoverned - there is nobody to bill", async () => {
    const { runWithAiBudget, reserveAiCall, debits } = await loadBudget({ allowed: true });
    await runWithAiBudget("", async () => {
      expect(await reserveAiCall()).toBe("ungoverned");
    });
    expect(debits).toEqual([]);
  });
});

describe("over the cap, the model is refused - not the turn", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("a user already over the cap gets no model calls", async () => {
    const { runWithAiBudget, reserveAiCall } = await loadBudget({ allowed: false });
    let ran = false;
    await runWithAiBudget("t@example.com", async () => {
      ran = true; // the TURN still runs...
      expect(await reserveAiCall()).toBe("over-cap"); // ...the MODEL does not.
    });
    expect(ran, "the turn must still run so the deterministic composer answers").toBe(true);
  });

  it("the allowance runs out mid-turn, and the rest of the turn degrades", async () => {
    const { runWithAiBudget, reserveAiCall } = await loadBudget({
      allowed: true,
      used: 118,
      limit: 120,
    });
    await runWithAiBudget("t@example.com", async () => {
      expect(await reserveAiCall()).toBe("ok");
      expect(await reserveAiCall()).toBe("ok");
      expect(await reserveAiCall()).toBe("over-cap");
    });
  });

  it("an over-cap scope debits nothing, because nothing was spent", async () => {
    const { runWithAiBudget, reserveAiCall, debits } = await loadBudget({ allowed: false });
    await runWithAiBudget("t@example.com", async () => {
      await reserveAiCall();
    });
    expect(debits).toEqual([]);
  });

  it("a throwing gate runs UNGOVERNED rather than halting the fleet", async () => {
    // checkDailyLimit already fails closed on an unreadable count, so reaching
    // the catch means something unexpected. Inventing a refusal there would
    // stop every negotiation in the system on one bad deploy.
    const { runWithAiBudget, reserveAiCall } = await loadBudget({ throwOnGate: true });
    await runWithAiBudget("t@example.com", async () => {
      expect(await reserveAiCall()).toBe("ungoverned");
    });
  });

  it("the work still runs when it throws, and the debit still lands", async () => {
    const { runWithAiBudget, reserveAiCall, debits } = await loadBudget({ allowed: true });
    await expect(
      runWithAiBudget("t@example.com", async () => {
        await reserveAiCall();
        throw new Error("turn blew up after the model was paid for");
      })
    ).rejects.toThrow(/blew up/);
    // The tokens were spent whether or not the turn finished.
    expect(debits).toEqual([{ kind: "ai", count: 1, who: "t@example.com" }]);
  });
});

describe("the scope is wired where the spend actually is", () => {
  it("chatDetailed - the one choke point - consults it", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/const reservation = await reserveAiCall\(\);/);
    expect(ai).toMatch(/if \(reservation === "over-cap"\)/);
    // The SAME failure shape as "no provider configured", so every existing
    // caller already handles it and the deterministic composer takes over.
    expect(ai).toMatch(/text: null,\s*error: "Daily AI limit reached/);
  });

  it("the inbound turn is wrapped at its single inner function", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/runWithAiBudget\(opts\.senderEmail \?\? "", runVendorTurn\)/);
    expect(loop).not.toMatch(/return await runVendorTurn\(\);/);
  });

  it("the scheduled wakeup and the judge are wrapped too", () => {
    // A timer-fired turn is the cheapest way to spend someone's budget without
    // them doing anything.
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/runWithAiBudget\(input\.ctx\.sender \?\? "", \(\) =>/);
    expect(engine).toMatch(/runWithAiBudget\(judgeOwner, \(\) =>/);
    // thread_key is `<email>:<vendor>`, so the owner is recoverable.
    expect(engine).toMatch(/const judgeOwner = sepIdx > 0 \? row\.thread_key\.slice\(0, sepIdx\) : "";/);
  });

  it("REGRESSION: the gate-without-debit is gone from extract-offer", () => {
    const route = readCode("src/app/api/extract-offer/route.ts");
    expect(route).not.toMatch(/const gate = await checkDailyLimit\("ai"/);
    expect(route).toMatch(/runWithAiBudget\(session\.email, async \(\) =>/);
    // An interactive request still gets a real 429 rather than a silent
    // degrade - a person is waiting on this one.
    expect(route).toMatch(/status: 429/);
  });

  it("the profiler is governed, and degrades to its existing heuristic", () => {
    const route = readCode("src/app/api/profile/route.ts");
    expect(route).toMatch(/runWithAiBudget\(session\?\.email \?\? "", \(\) =>/);
  });

  it("...and `recordApi(\"ai\")` now exists at all, which it never did before", () => {
    // The whole reason the single gate could never fire.
    expect(readCode("src/lib/ai-budget.ts")).toMatch(/recordApi\("ai", scope\.spent, email\)/);
  });
});
