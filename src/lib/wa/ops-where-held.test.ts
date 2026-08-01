import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readFileSync } from "fs";
import { join } from "path";
import { outboxState, CLAIM_LEASE_MS } from "./outbox-lifecycle";
import { classifyQueueReason, queueReasonLabel } from "../queue-reason";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "WHERE IS THIS MESSAGE HELD?" had no answer anywhere in the system.
//
// The Ops turn row's `queued` chip is written ONCE, into the turn detail, at
// compose time. `agent_events` is append-only and the route never joined to
// `wa_outbox` - so a turn sent at 12:43 still reads `queued` an hour later. A
// display bug, read as a delivery bug more than once.
//
// Everything needed was already there: the guard writes its own reason onto
// the row, `outboxState` is the definition every other surface reads, and
// `claimedAt` says whether a drainer is mid-send or died holding the lease.
// The route fetched all of it and reduced it to a count.

const inspector = readCode("src/app/api/admin/engine-inspector/route.ts");
const ui = readCode("src/components/admin/EngineInspector.tsx");
const guard = readCode("src/lib/wa-guard.ts");
const live = readCode("src/lib/spte/live.ts");

describe("a held row can now say what it is doing", () => {
  it("the state comes from the shared lifecycle definition, not a fresh guess", () => {
    const now = 1_700_000_000_000;
    expect(outboxState(new Date(now + 60_000).toISOString(), null, now)).toBe("waiting");
    expect(outboxState(new Date(now - 1_000).toISOString(), null, now)).toBe("due");
    expect(outboxState(new Date(now - 1_000).toISOString(), { claimedAt: now - 1_000 }, now)).toBe("sending");
    // Past the lease the holder is gone and the row is honestly due again.
    expect(
      outboxState(new Date(now - 1_000).toISOString(), { claimedAt: now - CLAIM_LEASE_MS - 1 }, now)
    ).toBe("due");
  });

  it("the reason is the guard's own words, and an empty one stays honest", () => {
    expect(classifyQueueReason("burst cooldown (46 in 600s)")).not.toBe("unknown");
    expect(classifyQueueReason("paused by you")).toBe("paused");
    expect(classifyQueueReason(null)).toBe("unknown");
    expect(queueReasonLabel("paused by you")).toMatch(/paused by you/i);
  });

  it("the route renders per-row state instead of throwing it away for a count", () => {
    expect(inspector).toMatch(/const held = queue\.slice\(0, 40\)\.map/);
    expect(inspector).toMatch(/state: outboxState\(r\.not_before, r\.meta \?\? null, now\)/);
    expect(inspector).toMatch(/reasonKind: classifyQueueReason\(r\.meta\?\.reason\)/);
    expect(inspector).toMatch(/reasonLabel: queueReasonLabel\(r\.meta\?\.reason\)/);
    expect(inspector).toMatch(/queue: \{ depth: queue\.length, dueNow, nextAt, lapsed: lapsedCount, held \}/);
  });

  it("A LAPSED CLAIM is finally visible - a drainer died mid-send", () => {
    // `lapsedClaims` was written for exactly this and never had a caller, so an
    // interrupted send was folklore.
    expect(inspector).toMatch(/const lapsed = Number\.isFinite\(claimedAt\) && now - claimedAt >= CLAIM_LEASE_MS/);
    expect(ui).toMatch(/interrupted mid-send/);
  });

  it("the panel shows it, and shows nothing when there is nothing held", () => {
    expect(ui).toMatch(/Held right now/);
    expect(ui).toMatch(/\(snap\.queue\.held\?\.length \?\? 0\) > 0/);
  });
});

describe("and the turn knows which row it went into", () => {
  it("the guard reports the row it parked the message in", () => {
    expect(guard).toMatch(/outboxRowId\?: number;/);
    const q = guard.slice(guard.indexOf("const queue = async"), guard.indexOf("  \/\/ -3. FAIL CLOSED"));
    expect(q).toMatch(/outboxRowId: mine\[0\]\?\.id/);
    // ...and the re-timed case already knew its own row.
    expect(q).toMatch(/outboxRowId: opts\.outboxRowId/);
  });

  it("...and the turn detail records it, so Ops can join exactly", () => {
    expect(live).toMatch(/let outboxRowId: number \| null = null;/);
    expect(live).toMatch(/outboxRowId = res\.outboxRowId \?\? null;/);
    expect(live).toMatch(/\n        outboxRowId,/);
  });
});

describe("the provider chip stops lying about every turn", () => {
  it("REPRODUCTION: the route's provider was declared and never assigned", () => {
    // `chat()` discards which provider answered; `chatDetailed` returns it. So
    // the Ops turn row fell through to `mock/local` on 100% of turns - and the
    // help text explained that meant no live key was used.
    const pass = readCode("src/lib/spte/pass.ts");
    // ...and the same call now also keeps the provider's FAILURE, so "no key
    // configured" and "every configured key is failing" stop looking identical.
    expect(pass).toMatch(/const \{ text: raw, provider, error \} = await chatDetailed\(/);
    expect(pass).toMatch(/if \(provider\) route\.provider = provider;/);
  });

  it("the route type reads the real provider list, not a hand-written subset", () => {
    // The union knew four of the nine configurable providers - its own way of
    // losing the truth.
    expect(readCode("src/lib/spte/types.ts")).toMatch(/provider\?: import\("\.\.\/ai"\)\.ProviderName;/);
    expect(readCode("src/lib/ai.ts")).toMatch(/export type ProviderName =/);
  });

  it("and the help text no longer describes a broken deployment", () => {
    const help = readCode("src/components/admin/engine/help.ts");
    expect(help).toMatch(/fell back to a deterministic template/);
    expect(help).not.toMatch(/'mock\/local' means no live key was used for that turn/);
  });
});
