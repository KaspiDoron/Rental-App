import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// A WAIT THAT CAME BACK WITH NO MEMORY OF WHY IT WAS WAITING.
//
// A strategic wait exists to return to a shop that has already quoted: "they
// said 400 - hold, then push". The tick then built its engine input with
// `usablePrice: undefined`.
//
// On the PRIMARY engine that is not a missing optimisation, it is amnesia.
// spte/live.ts reads `input.usablePrice` DIRECTLY with no fallback, so
// `found: Boolean(input.usablePrice)` was false, `quotedPricePerDay` was
// undefined and `quote` was null. The follow-up the wait was scheduled for is
// structurally impossible when the engine cannot see the number it is waiting
// on.
//
// And the reason nothing caught it is the interesting part: the GRAPH engine
// survived, because it falls back to `state.fields.pricePerDay`. The fallback
// path was fine and the default path was not.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("a scheduled wakeup remembers the price it was waiting on", () => {
  const engine = readCode("src/lib/graph/engine.ts");

  it("REGRESSION: the tick no longer hardcodes usablePrice to undefined", () => {
    expect(engine).not.toMatch(/usablePrice: undefined,/);
    expect(engine).toMatch(/usablePrice: threadPrice,/);
  });

  it("the price comes from the thread's durable offer, scoped to user AND vendor", () => {
    expect(engine).toMatch(/"offers",/);
    expect(engine).toMatch(/user_email=eq\.\$\{encodeURIComponent\(ctx\.sender\)\}/);
    expect(engine).toMatch(/vendor_id=eq\.\$\{encodeURIComponent\(ctx\.vendorId\)\}/);
    // Newest first - a thread that re-quoted must follow up on the new number.
    expect(engine).toMatch(/order=created_at\.desc&limit=1/);
  });

  it("an unreadable or missing offer degrades to exactly today's behaviour", () => {
    // undefined, which is what this code had unconditionally - so the failure
    // direction is the old behaviour rather than a worse one.
    expect(engine).toMatch(/if \(Number\.isFinite\(n\) && n > 0\) threadPrice = n;/);
    expect(engine).toMatch(/let threadPrice: number \| undefined;/);
  });

  it("extraction stays null - that really IS 'no new information'", () => {
    // Conflating the two is what produced the bug: a standing fact and a new
    // observation are different things, and only one of them is absent here.
    expect(engine).toMatch(/extraction: null,/);
  });

  it("and the primary engine still has no fallback of its own - which is why", () => {
    // If SPTE ever grows a fallback this test should be revisited; until then
    // it is the reason the caller has to supply the price.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/pricePerDay: input\.usablePrice,/);
    expect(live).toMatch(/found: Boolean\(input\.usablePrice\)/);
  });
});

describe("a model id that drifted is visible instead of merely expensive", () => {
  const ai = readCode("src/lib/ai.ts");

  it("REGRESSION: a rescued primary failure is no longer discarded", () => {
    const fn = ai.slice(ai.indexOf("async function callProvider"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/recordUsage\(cfg\.name, 0, true, cfg\.model, `primary model failed/);
    // Before the fallback runs, not after - a throw inside run() would skip it.
    // (The fallback run is awaited in a try with its own remaining-budget
    // argument; the ordering invariant - record BEFORE retry - is unchanged.)
    expect(body.indexOf("recordUsage(cfg.name, 0, true")).toBeLessThan(
      body.indexOf("await run(cfg.fallbackModel")
    );
  });

  it("it is awaited, because a detached insert dies at the response boundary", () => {
    const fn = ai.slice(ai.indexOf("async function callProvider"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/await recordUsage\(/);
  });

  it("the model recorded is the CONFIGURED one - the one that needs fixing", () => {
    const fn = ai.slice(ai.indexOf("async function callProvider"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // cfg.model, not the fallback that rescued it.
    expect(body).toMatch(/true, cfg\.model,/);
  });

  it("and the Providers panel already renders lastFailure, so nothing new is needed", () => {
    expect(ai).toMatch(/lastFailure: fails\[p\.name\] \?\? null,/);
  });
});

describe("the dead queue tier is labelled as dead", () => {
  function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try {
      entries = readdirSync(join(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("enqueueOutreachBatch still has zero producers - and says so in the file", () => {
    const callers = [...walk("src"), ...walk("services"), ...walk("apps"), ...walk("packages")]
      .filter((f) => !/\.test\./.test(f))
      .filter((f) => !f.endsWith("packages/queues/outreach.ts"))
      .filter((f) => !f.endsWith("packages/queues/index.ts")) // barrel re-export only
      .filter((f) => /enqueueOutreachBatch\s*\(/.test(readCode(f)));
    expect(
      callers,
      `someone wired the batch tier up. Update the note in packages/queues/outreach.ts and reconcile the duplicated pacing gates with /api/outreach/mass:\n${callers.join("\n")}`
    ).toEqual([]);
    // The comment is the deliverable here: the defect was that a reader would
    // reasonably assume batches flow through this queue.
    expect(readFileSync(join(process.cwd(), "packages/queues/outreach.ts"), "utf8")).toMatch(
      /THIS TIER IS BUILT, TESTED, AND NOT WIRED UP/
    );
  });
});
