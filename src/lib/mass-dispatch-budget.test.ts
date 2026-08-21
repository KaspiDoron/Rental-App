import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { mapLimit } from "./concurrency";

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P0-B: THE BATCH THAT COULD NOT FINISH.
//
// /api/outreach/mass compiled AND localized each shop's opener inside the
// dispatch loop - one awaited LLM round trip per shop, in series, inside a
// 60-second request ceiling. Ultra's batch is 24 shops, so the request ran out
// of budget partway and the tail of the batch was never queued: the traveller
// saw a hunt that had simply stopped, with no error anywhere.

describe("mapLimit runs work in a bounded pool", () => {
  it("returns results in INPUT order, whatever order the work finishes in", async () => {
    // A shop's opener landing on another shop's row is the failure this rules
    // out - the reason the pool cannot just be Promise.all + push.
    const out = await mapLimit([50, 10, 30, 0], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:50", "1:10", "2:30", "3:0"]);
  });

  it("NEVER exceeds the width - unbounded fan-out is a 429 storm", async () => {
    let live = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 24 }, (_, i) => i), 6, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    });
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak, "and it genuinely parallelises").toBeGreaterThan(1);
  });

  it("THE WHOLE POINT: 24 slow items cost pool-many rounds, not 24", async () => {
    // The serial version of this is 24 x 25ms = 600ms; the pool is 4 rounds.
    const t0 = Date.now();
    await mapLimit(Array.from({ length: 24 }, (_, i) => i), 6, async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    const elapsed = Date.now() - t0;
    expect(elapsed, `24 serial calls would take ~600ms; took ${elapsed}ms`).toBeLessThan(300);
  });

  it("a width larger than the work, or a silly width, still behaves", async () => {
    expect(await mapLimit([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapLimit([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapLimit([], 4, async (n) => n)).toEqual([]);
  });
});

describe("the mass route prepares openers before it dispatches", () => {
  const route = readCode("src/app/api/outreach/mass/route.ts");

  it("localization runs in the pool, not once per shop in the loop", () => {
    expect(route).toMatch(/mapLimit\(compiled, POOL/);
    // The serial shape that caused the timeout must stay gone.
    expect(route).not.toMatch(/await openerFor\(/);
  });

  it("compiling stays SEQUENTIAL - it shares the uniqueness ledger", () => {
    // Parallel compiles would race `compiledRecent` and let two shops receive
    // the same opener, which is the bot tell uniqueness exists to prevent.
    const prep = route.slice(route.indexOf("const openerByVendor"));
    expect(prep.slice(0, 1200)).toMatch(/for \(const \{ v, digits \} of withPhone\)/);
    expect(prep.slice(0, 1200)).toMatch(/await compileFor\(/);
    const compile = route.slice(route.indexOf("const compileFor = async"));
    expect(compile.slice(0, 1500)).toMatch(/compiledRecent\.push\(unique\.text\)/);
    // ...and compiling no longer awaits the model at all.
    expect(compile.slice(0, 1500)).not.toMatch(/await localizeMessage\(/);
  });

  it("one shop's localization failing does not take the batch down", () => {
    const prep = route.slice(route.indexOf("const openerByVendor"));
    expect(prep.slice(0, 1500)).toMatch(/localizeFor\([\s\S]{0,80}\)\.catch\(/);
  });

  it("a shop missed by the prepare pass still gets a real opener", () => {
    // Phones that only resolve via placeDetails are not in the pass.
    expect(route).toMatch(/openerByVendor\.get\(String\(v\.id\)\) \?\?/);
  });
});
