import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveThreadFacts } from "./spte/thread-facts";
import { compileOpener } from "./copy/promptCompiler";
import type { StructuredRFQ } from "./types";

vi.mock("server-only", () => ({}));

/** The opener's deterministic style seed. */
const seed = (id: string) => ({ threadId: id, vendorId: "v1", nonce: 0 });

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// FIVE WAYS THE ENGINE ARGUED WITH ITSELF.
//
// Each one had a correct version somewhere in the same codebase, and a second
// copy that never got the fix - which is the pattern worth naming, not the five
// bugs.

describe("a seat count nobody asked for", () => {
  it("REGRESSION: heurisitcRFQ no longer invents seats, like normalizeRFQ", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).not.toMatch(/seats: vehicleClass === "car" \? seats \?\? 4 : undefined/);
    expect(agents).toMatch(/seats: vehicleClass === "car" \? seats : undefined,/);
    // The rule already existed on the OTHER path, with a post-mortem attached.
    expect(agents).toMatch(/seats: rfq\.vehicleClass === "car" \? rfq\.seats : undefined,/);
  });

  it("and this path is not rare - it is every LLM failure", () => {
    // runProfiler returns heuristicRFQ DIRECTLY when the model gives nothing
    // back: no key, unparseable JSON, or the 9s budget expiring.
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/return heuristicRFQ\(input, durationDaysHint\);/);
  });

  it("seats really is disqualifying, which is why a phantom 4 silenced shops", () => {
    const spec = readCode("src/lib/vehicle/spec.ts");
    const seats = spec.slice(spec.indexOf("seats: {"));
    expect(seats.slice(0, seats.indexOf("},"))).toMatch(/disqualifying: true/);
    // ...and only DECLARED attributes block. That is the whole mechanism the
    // phantom default subverted.
    expect(spec).toMatch(/ATTRIBUTES\[k\]\.disqualifying && declared\[k\] !== undefined/);
  });
});

describe("our own answers are not bargain rounds", () => {
  // The `answer` template renders "is 250 THB/day the best you can do for 4
  // days?" - which the old regex matched twice over ("/day" AND "can you do") -
  // and the price-board read-back renders "I read 250 THB/day for the 4 days".
  const OUR_ANSWER = "Just to confirm - is 250 THB/day the best you can do for 4 days?";
  const OUR_BOARD_READ = "Thanks for the price list! I read 250 THB/day for the 4 days.";
  const A_REAL_PUSH = "Thanks! Any chance you can do a bit better for 4 days?";

  it("REPRODUCTION: the wording alone still reads our answer as a push", () => {
    // Unstamped - the fallback path. This is the old behaviour, and it is
    // WRONG; the point is that no regex can fix it, which is why the stamp had
    // to be threaded through.
    const blind = deriveThreadFacts({
      inbound: ["250 baht per day"],
      outbound: [OUR_ANSWER, OUR_BOARD_READ],
    });
    expect(blind.bargainRounds).toBe(2);
  });

  it("with the stamps supplied, they count for nothing", () => {
    const stamped = deriveThreadFacts({
      inbound: ["250 baht per day"],
      outbound: [OUR_ANSWER, OUR_BOARD_READ],
      outboundKinds: ["auto-answer", "auto-answer"],
    });
    expect(stamped.bargainRounds).toBe(0);
  });

  it("...and a real push still counts, so the cap has not gone soft", () => {
    const stamped = deriveThreadFacts({
      inbound: ["250 baht per day"],
      outbound: [OUR_ANSWER, A_REAL_PUSH],
      outboundKinds: ["auto-answer", "auto-bargain"],
    });
    expect(stamped.bargainRounds).toBe(1);
  });

  it("a mixed history heals: stamped trusted, unstamped falls back to wording", () => {
    // The heuristic exists for rows written before moves were stamped. It must
    // keep working for exactly those, and only those.
    const mixed = deriveThreadFacts({
      inbound: [],
      outbound: [OUR_ANSWER, "Could you do a better price for 4 days?"],
      outboundKinds: ["auto-answer", undefined],
    });
    expect(mixed.bargainRounds).toBe(1);
  });

  it("AND THE WORDING HEURISTIC WAS WRONG IN BOTH DIRECTIONS", () => {
    // Not just false positives. pass.ts's own `bargain` fallback renders "Any
    // chance you can do a bit better for N days?" - which matches NOTHING in
    // the regex ("you can do" is not "can you do"; "a bit better" is not
    // "better price"). So the old counter missed real pushes while counting our
    // answers. Two errors in opposite directions is not a threshold to tune; it
    // is a signal that cannot do the job, which is why the stamp now does it.
    const missed = deriveThreadFacts({ inbound: [], outbound: [A_REAL_PUSH] });
    expect(missed.bargainRounds).toBe(0);
    const counted = deriveThreadFacts({
      inbound: [],
      outbound: [A_REAL_PUSH],
      outboundKinds: ["auto-bargain"],
    });
    expect(counted.bargainRounds).toBe(1);
  });

  it("the stamped counter can still pull the number UP, never silently down", () => {
    // priorBargainCount is the caller's own count from message kinds; Math.max
    // keeps it authoritative when it is higher.
    const f = deriveThreadFacts({
      inbound: [],
      outbound: [OUR_ANSWER],
      outboundKinds: ["auto-answer"],
      priorBargainCount: 2,
    });
    expect(f.bargainRounds).toBe(2);
  });

  it("the engine actually supplies the stamps - the fix is wired, not just available", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(/priorOutboundKinds,/);
    expect(readCode("src/lib/spte/live.ts")).toMatch(
      /outboundKinds: input\.priorOutboundKinds,/
    );
  });
});

describe("a date in our own opener is not a price ask", () => {
  const policy = readCode("src/lib/spte/policy.ts");

  it("REGRESSION: both date orders are skipped before the band is applied", () => {
    expect(policy).toMatch(/DATE_AFTER\.test\(after\) \|\| DATE_BEFORE\.test\(before\)/);
    expect(policy).toMatch(/DATE_SEPARATOR_AFTER\.test\(after\)/);
  });

  it("REPRODUCTION: the opener really does contain a bare day number", () => {
    // "12 Aug" - formatRentalDate is deliberately never numeric, so the day
    // stands alone next to a month NAME, which no measurement-unit guard
    // catches. That "12" was read as an ask below an EUR 18 quote.
    const rfq = {
      vehicleClass: "scooter",
      engineSizeCc: 110,
      transmission: "any",
      durationDays: 4,
      accessories: [],
      fulfillment: "in-store",
      startDate: "2026-08-12",
    } as unknown as StructuredRFQ;
    const opener = compileOpener(rfq, seed("t:1"));
    expect(opener).toMatch(/\b12 Aug\b/);
  });

  it("the module's own patterns cover every date shape we or a shop can write", () => {
    // Rebuilt from the source so the test cannot drift from the regexes it
    // checks: a copy of the pattern would pass forever while the real one rots.
    const monthSrc = /const MONTH_NAME =\s*\n?\s*"([^"]+)"/.exec(policy)![1];
    const after = new RegExp(`^\\s*(?:st|nd|rd|th)?\\s*(?:of\\s+)?(?:${monthSrc})\\b`, "i");
    const before = new RegExp(`(?:${monthSrc})\\s*$`, "i");
    const sepAfter = /^\s?[/-]\s?\d/;

    // "12 Aug" (ours), "12th of August", "12 January"
    for (const tail of [" Aug", "th of August", " January"]) expect(after.test(tail)).toBe(true);
    // "Aug 12", "August 12"
    for (const head of ["starting Aug ", "from August "]) expect(before.test(head)).toBe(true);
    // "12/08", "12-08"
    for (const tail of ["/08", "-08"]) expect(sepAfter.test(tail)).toBe(true);

    // ...and a genuine ask is still an ask. "/day" and a bare number must NOT
    // be read as a date, or the guard would silence every real push instead.
    expect(after.test("/day, could you?")).toBe(false);
    expect(before.test("can you do ")).toBe(false);
  });
});

describe("the lever leverage.ts withheld stays withheld", () => {
  const pass = readCode("src/lib/spte/pass.ts");

  it("REGRESSION: both fallbacks are gated on the session low", () => {
    expect(pass).toMatch(/const atLow = atSessionLow\(ctx\);/);
    expect(pass).toMatch(/!lead && !atLow && round <= 0 && days >= 3/);
    expect(pass).toMatch(/first push, and they are ALREADY the best price you have/);
  });

  it("the state they keyed on IS the one planLeverage creates", () => {
    // planLeverage returns [] for isSessionLow && round < 1, so leadCard gives
    // undefined, so `!lead` is true - the fallbacks fired precisely there.
    const lev = readCode("src/lib/negotiation/leverage.ts");
    expect(lev).toMatch(/if \(input\.isSessionLow\) \{/);
    expect(lev).toMatch(/if \(input\.round >= 1\) \{/);
    expect(lev).toMatch(/return cards;/);
  });

  it("one nudge at the floor is still legal - it is re-aimed, not removed", () => {
    expect(pass).toMatch(/ask for something thrown in instead/);
    expect(pass).not.toMatch(/atLow \? "" :/);
  });
});

describe("the opener says what the traveller actually asked for", () => {
  const base = {
    vehicleClass: "scooter",
    engineSizeCc: 110,
    transmission: "any",
    durationDays: 4,
    accessories: [],
    fulfillment: "in-store",
  } as unknown as StructuredRFQ;

  it("REPRODUCTION: a one-way drop-off reaches the shop", () => {
    // It survived the profiler and then reappeared only at BOOKING time, so the
    // entire negotiation priced a round trip and the one-way fee arrived at
    // handover. Unlike delivery, nothing downstream could recover it.
    const opener = compileOpener({ ...base, oneWayDropOff: "Pai" }, seed("t:2"));
    expect(opener).toMatch(/Pai/);
    expect(opener.toLowerCase()).toMatch(/one-way|leaving it|rather than bringing it back/);
  });

  it("a delivery request is asked about, with NO address in it", () => {
    const opener = compileOpener({ ...base, fulfillment: "hotel-delivery" }, seed("t:3"));
    expect(opener.toLowerCase()).toMatch(/deliver/);
  });

  it("and neither appears when neither was asked for", () => {
    const opener = compileOpener(base, seed("t:4"));
    expect(opener.toLowerCase()).not.toMatch(/one-way|deliver/);
  });

  it("the seeded phrasings vary, like every other slot in the matrix", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(
        compileOpener({ ...base, oneWayDropOff: "Pai" }, seed(`t:${i}`))
      );
    }
    // A fixed literal on every thread is a fingerprint; that is the whole point
    // of the matrix this clause was added to.
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("the deal-memory loop reads what it writes", () => {
  const live = readCode("src/lib/spte/live.ts");

  it("REGRESSION: priors is no longer pinned to null", () => {
    // `rememberDeal` IS wired at negotiate/close-deal:208, so deal_memory
    // filled up forever - and `dealPrior`, which computes the median achieved
    // price from it, had ZERO callers. After a thousand closed deals in one
    // region, the thousand-and-first negotiation anchored on exactly the same
    // information as the first.
    expect(live).not.toMatch(/priors: null,/);
    expect(live).toMatch(/priors,\s*\n\s*coaching,/);
    expect(live).toMatch(/priors = await dealPrior\(regionKey, input\.rfq\);/);
  });

  it("it uses the SAME region key the writer uses", () => {
    // rememberDeal stores `region.toLowerCase()`; a different normalisation
    // here would look wired and still return nothing forever.
    const write = readCode("src/app/api/negotiate/close-deal/route.ts");
    expect(write).toMatch(/regionKey: region\.toLowerCase\(\)/);
    expect(live).toMatch(/String\(input\.ctx\.region \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
  });

  it("a thin prior still cannot over-anchor, and a failure is not fatal", () => {
    expect(readCode("src/lib/spte/memory.ts")).toMatch(/if \(rows\.length < 3\) return null;/);
    // readCode strips comments, so read the raw file for the rationale.
    expect(readFileSync(join(process.cwd(), "src/lib/spte/live.ts"), "utf8")).toMatch(
      /a prior is grounding, never a requirement/
    );
  });

  it("and the prompt line that consumes it exists, so this is now visible", () => {
    expect(readCode("src/lib/spte/pass.ts")).toMatch(/Past travellers here landed around/);
  });
});
