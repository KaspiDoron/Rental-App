import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source-level regression pins for fixes whose behavior is integration-bound
// (SQL filters, external-fetch timeouts, instance-create bodies) and cannot be
// exercised as a pure unit. These assert the dangerous pattern stays GONE and
// the safe one stays present, so a future edit cannot silently reintroduce the
// confirmed defect.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Strip line + block comments so structural assertions match CODE, not the
// explanatory prose (which deliberately names the patterns being guarded).
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const count = (hay: string, needle: RegExp) => (hay.match(needle) ?? []).length;

describe("privacy: no unescaped SQL LIKE wildcard on user identity (cross-user leak)", () => {
  it("no `thread_key=like.` QUERY remains in src (graph_wakeups uses user_email=eq.)", () => {
    // Match the actual query form (template interpolation), not the prose in
    // the explanatory comments that document why the pattern was removed.
    for (const f of [
      "src/app/api/session/close/route.ts",
      "src/app/api/negotiate/close-deal/route.ts",
      "src/app/api/deals/route.ts",
      "src/app/api/activity/route.ts",
      "src/lib/will-answers.ts",
    ]) {
      expect(read(f)).not.toMatch(/thread_key=like\.\$\{/);
    }
  });

  it("wa_sessions reads use exact `email=eq.`, never `email=ilike.` (an `_` is a SQL wildcard)", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/email=ilike\./);
  });
});

describe("privacy/data-minimization: syncFullHistory is never requested true", () => {
  it("evolution.ts declares syncFullHistory only as false, on every instance/create path", () => {
    const evo = read("src/lib/evolution.ts");
    expect(evo).not.toMatch(/syncFullHistory:\s*true/);
    // and it IS declared (so the create bodies actively opt out, not just omit)
    expect(count(evo, /syncFullHistory:\s*false/g)).toBeGreaterThanOrEqual(3);
  });
});

describe("resilience: external fetches are bounded by a hard timeout", () => {
  it("evoFetch aborts on a timeout (a cold Evolution host cannot hang the drain)", () => {
    const evo = read("src/lib/evolution.ts");
    const start = evo.indexOf("async function evoFetch");
    expect(start).toBeGreaterThan(-1);
    const body = evo.slice(start, evo.indexOf("async function", start + 10));
    expect(body).toMatch(/AbortController/);
    expect(body).toMatch(/ctrl\.abort\(\)/);
    expect(body).toMatch(/signal:\s*ctrl\.signal/);
  });

  it("every Supabase helper goes through timedFetch (only timedFetch's own call is a raw fetch)", () => {
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).toMatch(/async function timedFetch/);
    // Exactly one raw lowercase `fetch(` survives in code: the one inside
    // timedFetch itself (all helpers call via `timedFetch(` - capital F).
    expect(count(code, /fetch\(/g)).toBe(1);
  });

  it("timedFetch keeps its deadline armed across the body read (no header-boundary clear)", () => {
    // The abort deadline must span headers+body: fetch() resolves at headers but
    // the read helpers then `await res.json()`. Clearing the timer at the header
    // boundary left the body read unbounded (a mid-body DB stall hung the handler
    // and, on the drain path, lost an already-claimed row).
    const code = readCode("src/lib/runtime-config.ts");
    expect(code).not.toMatch(/clearTimeout/);
    expect(code).toMatch(/\.unref\?\.\(\)/);
  });
});
