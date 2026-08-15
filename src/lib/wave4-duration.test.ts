import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { deriveReturnDate } from "./rental-window";
import { promiseOf, reconcileRfq } from "./wa/rental-params";
import { dayWord, nDays } from "./copy/matrix";
import type { StructuredRFQ } from "./types";

// W4.1 - THE DURATION PIPELINE (owner report 5 #2/#7).
//
// The traveller searched a 3-DAY rental. Twenty shops were asked about
// "16 Aug until 17 Aug" - one day - and mid-negotiation the agents flipped
// back to 3, quoting a length no shop had been asked about. Three independent
// defects, each fixed here and each pinned so a revert goes red:
//
//   1. /api/profile applied the explicit pickup DATE and never the explicit
//      DURATION, then derived returnDate from the LLM's number.
//   2. The picker was a FALLBACK hint (`rfq.durationDays || hint`), so any
//      truthy LLM value - including an invented 1 - beat the traveller's 3;
//      the prompt made durationDays REQUIRED with a floor of 1, so a model
//      handed prose with no length had to guess, and 1 was the cheapest guess.
//   3. The opener rendered the date RANGE and dropped the day count, so the
//      wrong number was invisible on the wire instead of being contradicted;
//      six follow-up composers still wrote "for the 1 days"; and the two
//      traveller-driven composers (Bargain draft, custom send) composed from
//      the client's live rfq and RE-STAMPED it, minting a new anchor.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const rfqOf = (over: Partial<StructuredRFQ> = {}): StructuredRFQ => ({
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  ...over,
});

describe("deriveReturnDate - the ONE writer of returnDate", () => {
  it("start + duration, overwriting an LLM date that contradicts the pair", () => {
    // The exact field shape: 3 days from the 16th ends on the 19th, not the
    // 17th the model wrote next to durationDays: 3.
    const out = deriveReturnDate(rfqOf({ startDate: "2026-08-16", returnDate: "2026-08-17", durationDays: 3 }));
    expect(out.returnDate).toBe("2026-08-19");
  });

  it("a one-day rental still gets a real window", () => {
    expect(deriveReturnDate(rfqOf({ startDate: "2026-08-16", durationDays: 1 })).returnDate).toBe(
      "2026-08-17"
    );
  });

  it("no start date means no pair to reconcile - the RFQ is untouched", () => {
    const rfq = rfqOf({ returnDate: "2026-08-17" });
    expect(deriveReturnDate(rfq)).toBe(rfq);
  });

  it("a nonsense duration never invents a window", () => {
    const rfq = rfqOf({ startDate: "2026-08-16", durationDays: 0 });
    expect(deriveReturnDate(rfq)).toBe(rfq);
  });
});

describe("the plural is decided in ONE place", () => {
  it("1 day, 2 days - the shop-facing counted form", () => {
    expect(dayWord(1)).toBe("day");
    expect(dayWord(3)).toBe("days");
    expect(nDays(1)).toBe("1 day");
    expect(nDays(3)).toBe("3 days");
  });

  it("no live composer hard-codes the plural after an interpolation", () => {
    // The first fix stopped at the opener matrix; SPTE's own templates (the
    // LIVE engine), the re-check message, the bargain fallback pool and the
    // disclosure guidance kept writing "for the 1 days".
    for (const p of [
      "src/lib/spte/pass.ts",
      "src/lib/wa/recheck-message.ts",
      "src/lib/agents.ts",
      "src/lib/negotiation/traveller-disclosure.ts",
    ]) {
      const src = read(p).replace(/\/\/.*$/gm, "");
      expect(src, `${p} still hard-codes a plural`).not.toMatch(/\$\{days\} days/);
      expect(src, `${p} still hard-codes a plural`).not.toMatch(
        /\$\{opts\.rfq\.durationDays\} days/
      );
    }
  });
});

describe("explicit traveller input beats LLM inference", () => {
  it("/api/profile overrides the DURATION, not only the date", () => {
    const route = read("src/app/api/profile/route.ts");
    expect(route).toMatch(/function requestedDays/);
    // W9 - REWRITTEN, INTENT PRESERVED. The pin was `...(days ? {durationDays:
    // days} : {})`, which was correct only while the page sent the field ONLY
    // when touched - and that gate is exactly what stopped the default search
    // from carrying any window at all. The window now travels on every typed
    // search and `windowExplicit` says which half was set, so the override the
    // traveller SET still wins outright while the one they merely saw does not
    // overrule their own words. Same doctrine, one more bit on the wire.
    expect(route).toMatch(/\.\.\.\(days && explicit\.durationDays \? \{ durationDays: days \} : \{\}\)/);
    expect(route).toMatch(/function explicitWindow/);
    // ...and the return date is derived from the OVERRIDDEN pair, by the one
    // writer - never computed from the profiler's number.
    expect(route).toMatch(/deriveReturnDate\(\{/);
    expect(route).not.toMatch(/returnDate: addDays\(start, profiled\.durationDays\)/);
  });

  it("normalizeRFQ treats the picker as a statement, not a fallback", () => {
    const agents = read("src/lib/agents.ts");
    // The old precedence let an invented 1 beat the traveller's 3.
    expect(agents).not.toMatch(/clampDuration\(rfq\.durationDays \|\| durationHint\)/);
    expect(agents).toMatch(/const hinted = requestedDuration\(durationHint\)/);
    // W9 - REWRITTEN, INTENT PRESERVED. Was `clampDuration(hinted ??
    // rfq.durationDays)`. The precedence it pins is unchanged - the picker
    // outranks the parse - but the LAST resort is no longer a hard-coded 3
    // buried in clampDuration: it is the day count the window control was
    // showing when the traveller pressed the button, which is the only number
    // they can be said to have seen. Executed coverage in w9-duration-truth.
    expect(agents).toMatch(/clampDuration\(hinted \?\? stated \?\? defaultDurationDays\)/);
  });

  it("the profiler is no longer FORCED to invent a length", () => {
    const prompt = read("src/lib/prompts.ts");
    expect(prompt).toMatch(/durationDays\?: number \(ONLY if the traveller stated how long/);
    expect(prompt).toMatch(/never invent a date, a trip length or an age/);
    // The old required-with-a-floor shape is gone.
    expect(prompt).not.toMatch(/ durationDays: number,/);
  });

  it("a duration the app changed is SHOWN to the traveller", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/const durationChanged =/);
    expect(page).toMatch(/We searched for \{n\} days, not \{asked\}/);
  });
});

describe("the opener states the day count as well as the range", () => {
  it("both facts travel, so a wrong one contradicts on the wire", () => {
    const matrix = read("src/lib/copy/matrix.ts");
    // The range renderer no longer suppresses the duration phrase.
    expect(matrix).toMatch(/export const dayWord/);
    expect(matrix).toMatch(/export const nDays/);
    const compiler = read("src/lib/copy/promptCompiler.ts");
    expect(compiler).toMatch(/duration/i);
  });
});

describe("the mid-thread flip: a composer cannot outrank the promise", () => {
  it("reconcileRfq keeps the shop's quoted terms and drops a contradicting window", () => {
    // The client's live rfq says 3 days; the thread was opened for 1.
    const opener = rfqOf({ durationDays: 1 });
    const promise = promiseOf(opener, "I'm hoping to get a scooter from 16 Aug until 17 Aug", null);
    const live = rfqOf({ durationDays: 3, startDate: "2026-08-16", returnDate: "2026-08-19" });
    const settled = reconcileRfq(live, promise)!;
    expect(settled.durationDays).toBe(1);
    // A returnDate computed from the wrong duration is the same lie elsewhere.
    expect(settled.returnDate).toBeUndefined();
  });

  it("the Bargain draft composes on the promise and records the drift", () => {
    const route = read("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/promisedRfq\(digits, session\.email, rfq\)/);
    expect(route).toMatch(/kind: "rfq-drift"/);
  });

  it("every send STAMPS the reconciled rfq - an opener is exempt (it IS the promise)", () => {
    const route = read("src/app/api/outreach/route.ts");
    expect(route).toMatch(/const settledRfq =/);
    expect(route).toMatch(/kind === "rfq"\s*[\r\n]?\s*\? \(\(body\.rfq as StructuredRFQ/);
    // Both stamp sites carry the reconciled value, never the raw client rfq.
    expect(route).not.toMatch(/rfq: body\.rfq \?\? null/);
    expect((route.match(/rfq: settledRfq \?\? null/g) ?? []).length).toBe(2);
  });

  // W9 - THE BAN ABOVE READ THE WRONG FILE, WHICH IS WORSE THAN NOT EXISTING.
  //
  // `rfq: body.rfq ?? null` - the exact anti-pattern the assertion above bans -
  // lived verbatim in the SIBLING route, /api/outreach/mass, and no test read
  // that file. Mass is the primary hunt send path (page.tsx calls it for the
  // whole batch), so the guarded route was the quiet one and the unguarded one
  // sent the volume. A ban is only as good as the files it is pointed at.
  it("...INCLUDING the mass route, which sends the whole hunt", () => {
    // Comments stripped: the post-mortem above the fix quotes the banned line.
    const route = read("src/app/api/outreach/mass/route.ts").replace(/\/\/.*$/gm, "");
    expect(route, "the banned stamp is back on the mass path").not.toMatch(
      /rfq: body\.rfq \?\? null/
    );
    expect(route).toMatch(/const settledRfq = isNewIntro/);
    expect(route).toMatch(/promisedRfq\(digits, session\.email, body\.rfq as StructuredRFQ/);
    expect(route).toMatch(/rfq: settledRfq \?\? null/);
  });

  it("promisedRfq degrades to the client rfq - it can only pull toward the promise", () => {
    const ctx = read("src/lib/wa/thread-context.ts");
    expect(ctx).toMatch(/export async function promisedRfq/);
    // First contact (no opener row) and a failed read both pass through.
    expect(ctx).toMatch(/if \(!opener\) return \{ rfq, drifted: false \}/);
    expect(ctx).toMatch(/catch \{\s*[\r\n]\s*return \{ rfq, drifted: false \};/);
  });
});
