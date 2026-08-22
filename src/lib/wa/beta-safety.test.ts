import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, wave A - the launch blockers.

describe("A2: the host cap actually refuses", () => {
  const evo = read("src/lib/evolution.ts");

  it("THE REGRESSION: a full fleet no longer places the user anyway", () => {
    // `underCap.length ? underCap : pickFrom` meant the cap did nothing at the
    // exact moment it mattered - with one host, all 50 testers on one 512MB box.
    expect(evo).not.toMatch(/const pool = underCap\.length \? underCap : pickFrom;/);
    expect(evo).toMatch(/if \(!underCap\.length\) return null;/);
  });

  it("the default cap is the conservative 25, not 40", () => {
    // Evolution's own production floor is 2 vCPU/2GB; ours is 512MB.
    const fn = evo.slice(evo.indexOf("export async function maxPerHost"));
    expect(fn.slice(0, 300)).toMatch(/: 25;/);
    expect(fn.slice(0, 300)).not.toMatch(/: 40;/);
  });
});

describe("A3: SCALE_MODE never touches number safety", () => {
  const usage = read("src/lib/usage.ts");

  it("THE REGRESSION: the four anti-ban budgets are excluded from the multiplier", () => {
    expect(usage).toMatch(/NEVER_SCALED/);
    for (const n of [
      "LIMIT_WA_INTRO_PER_HOUR",
      "LIMIT_WA_INTRO_PER_DAY",
      "LIMIT_WA_REPLY_PER_HOUR",
      "LIMIT_WA_REPLY_PER_DAY",
    ]) {
      expect(usage, n).toMatch(new RegExp(`NEVER_SCALED[\\s\\S]{0,300}"${n}"`));
    }
    expect(usage).toMatch(/if \(NEVER_SCALED\.has\(name\)\) return base;/);
  });

  it("the exclusion happens BEFORE the multiplier, not after", () => {
    const fn = usage.slice(usage.indexOf("export async function limitFor"));
    const guard = fn.indexOf("NEVER_SCALED.has(name)");
    const mult = fn.indexOf("base * 3");
    expect(guard).toBeGreaterThan(-1);
    expect(mult).toBeGreaterThan(-1);
    expect(guard, "the early return must precede the triple").toBeLessThan(mult);
  });

  it("an explicit owner override is still honoured for those names", () => {
    // Typing a number deliberately is a decision; flipping a scale switch is not.
    const fn = usage.slice(usage.indexOf("export async function limitFor"));
    const base = fn.indexOf("const base =");
    const guard = fn.indexOf("NEVER_SCALED.has(name)");
    expect(base).toBeLessThan(guard);
  });

  it("EXECUTED: SCALE_MODE on triples a normal limit but not a WA one", async () => {
    vi.resetModules();
    vi.doMock("../runtime-config", () => ({
      getConfig: vi.fn(async (k: string) => (k === "SCALE_MODE" ? "on" : null)),
      sbSelect: vi.fn(async () => []),
      sbInsert: vi.fn(async () => true),
      sbSelectStrict: vi.fn(async () => ({ rows: [] })),
    }));
    const { limitFor, limitDefaults } = await import("../usage");
    const d = limitDefaults();
    expect(await limitFor("LIMIT_WA_INTRO_PER_DAY")).toBe(d.LIMIT_WA_INTRO_PER_DAY);
    expect(await limitFor("LIMIT_WA_REPLY_PER_HOUR")).toBe(d.LIMIT_WA_REPLY_PER_HOUR);
    // ...while a capacity-shaped limit still scales, which is the point of the switch.
    expect(await limitFor("LIMIT_SEARCHES_PER_DAY")).toBe(d.LIMIT_SEARCHES_PER_DAY * 3);
  });
});

describe("A6: a held reply is re-parked, not destroyed", () => {
  const engine = read("src/lib/graph/engine.ts");

  it("THE REGRESSION: the inline path applies the drain's own needsRepark rule", () => {
    const block = engine.slice(engine.indexOf("A COMPOSED REPLY MUST NOT DIE HERE"));
    expect(block.slice(0, 2200)).toMatch(/needsRepark\(verdict\)/);
    expect(block.slice(0, 2200)).toMatch(/parkOutboxOnce\(\{/);
  });

  it("a TERMINAL verdict is still a deliberate drop - never resurrected", () => {
    // needsRepark itself encodes this; assert the contract it relies on.
    const policy = read("src/lib/wa/outbox-policy.ts");
    const fn = policy.slice(policy.indexOf("export function needsRepark"));
    expect(fn.slice(0, 400)).toMatch(/if \(verdict\.terminal\) return false;/);
    expect(fn.slice(0, 400)).toMatch(/if \(verdict\.queuedUntil\) return false;/);
    expect(fn.slice(0, 400)).toMatch(/if \(verdict\.allow\) return false;/);
  });

  it("the park carries the guard's own text, already humanized", () => {
    const block = engine.slice(engine.indexOf("A COMPOSED REPLY MUST NOT DIE HERE"));
    expect(block.slice(0, 2200)).toMatch(/body: verdict\.text \?\? text/);
    expect(block.slice(0, 2200)).toMatch(/alreadyHumanized: true/);
  });
});
