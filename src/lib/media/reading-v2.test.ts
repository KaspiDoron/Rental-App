import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  burstFollowerRows,
  classifyReading,
  readingEmptyLine,
  readingFrom,
  readingHeadline,
  readingIsEmpty,
  readingIsFailure,
} from "./reading";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE FIELD FAILURE (owner report 5, #1/#4/#6 - screenshot-verified).
//
// A shop sent ONE clear photo of a typed price menu: a 3x3 grid where every
// cell was machine-readable ("Honda Click 125cc / Deposit: 3,000 THB or
// Passport / Price Per Day: 250 THB"), including the EXACT vehicle the
// traveller had asked for, with a few models struck out in red. The panel told
// the traveller:
//
//     "We could not read anything usable from this one."
//     CONFIDENCE: LOW
//     "No usable price in this image."
//
// All three sentences are claims about the PHOTO. Not one of them was true: the
// photo was fine, and the failure was ours - in the observed cases an
// unparseable model answer, a generation cut off at our own token ceiling, or a
// price we read and then erased with the plausibility net. They collapsed into
// the ONE artefact reserved for "the photo was blank" because the reading had
// no vocabulary for a reader that breaks.
//
// Everything below EXECUTES the classifier and the copy. Reading is pure by
// design precisely so the honesty rule can be tested without a model.

describe("an honest taxonomy: our failures are never reported as their photo", () => {
  it("THE REGRESSION: the model answered, the JSON did not parse", () => {
    // seen:true with no summary and no price - byte-identical to a blank board
    // until `modelFailure` existed.
    const r = readingFrom({
      found: false,
      confidence: "low",
      imageRead: { seen: true, modelFailure: "parse-failed" },
    });
    expect(r.outcome).toBe("parse-failed");
    expect(readingIsFailure(r)).toBe(true);
    expect(readingEmptyLine(r)).not.toMatch(/could not read anything usable/i);
    expect(readingEmptyLine(r)).toMatch(/our side failing, not your photo/i);
    expect(readingEmptyLine(r)).toMatch(/retried/i);
    expect(readingHeadline(r)).not.toMatch(/nothing readable/i);
    expect(readingHeadline(r)).toMatch(/re-reading/i);
  });

  it("a MAX_TOKENS cut-off is our ceiling, not their board", () => {
    const r = readingFrom({ found: false, imageRead: { seen: true, modelFailure: "truncated" } });
    expect(r.outcome).toBe("truncated");
    expect(readingEmptyLine(r)).toMatch(/our limit, not your photo/i);
    expect(readingEmptyLine(r)).not.toMatch(/could not read anything usable/i);
    // ...and the same is true when the WHOLE ladder ended cut off, which the
    // ladder reports as a failure rather than as a never-ran outage.
    const ladder = readingFrom({ imageRead: { seen: false, failure: "truncated" } });
    expect(ladder.outcome).toBe("truncated");
    expect(readingEmptyLine(ladder)).not.toMatch(/image reader was unavailable/i);
  });

  it("a price we read and then rejected SHOWS THE NUMBER we rejected", () => {
    // The sanity net used to null the price, flip found=false and force
    // confidence "low" ~400 lines before the reading was built, so a photo the
    // model had read perfectly produced the identical "nothing usable" panel.
    const r = readingFrom({
      found: false,
      imageRead: {
        seen: true,
        modelFailure: "sanity-nulled",
        rejectedPricePerDay: 25_000,
        rejectedCurrency: "THB",
      },
    });
    expect(r.outcome).toBe("sanity-nulled");
    expect(r.rejectedPricePerDay).toBe(25_000);
    expect(readingEmptyLine(r)).toMatch(/we read 25000 THB\/day/i);
    expect(readingEmptyLine(r)).toMatch(/asking the shop to confirm/i);
    expect(readingEmptyLine(r)).not.toMatch(/could not read anything usable/i);
    expect(readingHeadline(r)).toMatch(/looks wrong/i);
  });

  it("...and it still degrades honestly when the number did not survive", () => {
    const r = readingFrom({ imageRead: { seen: true, modelFailure: "sanity-nulled" } });
    expect(r.rejectedPricePerDay).toBeUndefined();
    expect(readingEmptyLine(r)).toMatch(/cannot be right for this area/i);
    expect(readingEmptyLine(r)).not.toMatch(/undefined|NaN/);
  });

  it("a GENUINELY blank photo still says so - this is not blanket optimism", () => {
    const r = readingFrom({ found: false, imageRead: { seen: true } });
    expect(r.outcome).toBe("empty");
    expect(readingIsFailure(r)).toBe(false);
    expect(readingEmptyLine(r)).toBe("We could not read anything usable from this one.");
    expect(readingHeadline(r)).toBe("Nothing readable in this one");
  });

  it("an outage is still an outage, and still outranked by a named model failure", () => {
    expect(readingFrom({ imageRead: { seen: false, failure: "rate-limit" } }).outcome).toBe(
      "unavailable"
    );
    // A ladder that never ran AND a stamped model failure: the specific one
    // wins, because "the image reader was unavailable" would be the same lie in
    // a different costume.
    const both = readingFrom({
      imageRead: { seen: false, failure: "timeout", modelFailure: "truncated" },
    });
    expect(both.outcome).toBe("truncated");
  });

  it("the classifier itself is the fix, so it is tested directly", () => {
    expect(classifyReading({}, true)).toBe("empty");
    expect(classifyReading({}, false)).toBe("read");
    expect(classifyReading({ imageRead: { seen: false } }, true)).toBe("unavailable");
    expect(classifyReading({ imageRead: { seen: true, modelFailure: "parse-failed" } }, true)).toBe(
      "parse-failed"
    );
    // A model failure outranks blankness: content or no content, the reason we
    // have nothing is still ours.
    expect(classifyReading({ imageRead: { seen: true, modelFailure: "truncated" } }, false)).toBe(
      "truncated"
    );
    // Junk from the boundary never invents an outcome.
    expect(classifyReading({ imageRead: { seen: true, modelFailure: "banana" } }, true)).toBe(
      "empty"
    );
    expect(classifyReading(null, true)).toBe("empty");
    expect(classifyReading(undefined, false)).toBe("read");
  });

  it("every failure class is caught by the ONE predicate the panel asks", () => {
    for (const modelFailure of ["parse-failed", "truncated", "sanity-nulled"]) {
      const r = readingFrom({ imageRead: { seen: true, modelFailure } });
      expect(readingIsFailure(r), modelFailure).toBe(true);
      // The collapsed row is the line most travellers ever see.
      expect(readingHeadline(r), modelFailure).not.toBe("Nothing readable in this one");
    }
    expect(readingIsFailure(readingFrom({ imageRead: { seen: false } }))).toBe(true);
    expect(readingIsFailure(readingFrom({ imageSummary: "Click 125, 250 THB/day" }))).toBe(false);
    expect(readingIsFailure(null)).toBe(false);
  });

  it("a sanity-nulled reading KEEPS what was read - the net must not lie", () => {
    // The whole point of #4: preserve the reading, mark it, show the rejected
    // number. A panel with rows plus "we will not quote this" is honest; a
    // blank panel about a board we read is not.
    const r = readingFrom({
      found: false,
      imageSummary: "Board: CLICK 125cc 250B/day, NMAX 350B/day",
      options: [{ pricePerDay: 250, currency: "THB", model: "Honda Click 125" }],
      imageRead: { seen: true, modelFailure: "sanity-nulled", rejectedPricePerDay: 25_000 },
    });
    expect(readingIsEmpty(r)).toBe(false);
    expect(r.prices.map((p) => p.pricePerDay)).toEqual([250]);
    expect(r.text).toMatch(/CLICK 125cc/);
  });
});

describe("the fields the live extractor can now actually fill", () => {
  it("per-option currency and tierLabel survive into the panel's chip", () => {
    const r = readingFrom({
      options: [
        { pricePerDay: 600, currency: "THB", tierLabel: "1-2 days", model: "Click 125" },
        { pricePerDay: 500, currency: "THB", tierLabel: "15-29 days", model: "Click 125" },
      ],
    });
    expect(r.prices[0]).toMatchObject({ pricePerDay: 500, currency: "THB", tierLabel: "15-29 days" });
  });

  it("a crossed-out row is KEPT and marked, never dropped and never quoted", () => {
    const r = readingFrom({
      options: [
        { pricePerDay: 250, model: "Honda Click 125", available: true },
        { pricePerDay: 200, model: "Yamaha Fino", available: false },
      ],
    });
    expect(r.prices.map((p) => p.pricePerDay)).toEqual([200, 250]); // never dropped
    expect(r.prices.find((p) => p.pricePerDay === 200)?.available).toBe(false);
    expect(r.prices.find((p) => p.pricePerDay === 250)?.available).toBe(true);
    // Silence about availability stays silence - most boards cross nothing out.
    expect(readingFrom({ options: [{ pricePerDay: 250 }] }).prices[0].available).toBeUndefined();
  });
});

describe("every photo of a burst carries the burst's reading", () => {
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1_000).toISOString();
  const leader = { id: 12, wa_message_id: "m-12", received_at: at(6), raw: { media: { key: "k" } } };

  it("THE REGRESSION: the stood-down frame gets the leader's reading", () => {
    // Burst coalescing runs ONE turn for an album on the NEWEST frame; the
    // earlier frames never get a turn of their own, so without this they render
    // in the conversation forever unexplained (owner report 5, #6).
    const rows = [
      leader,
      { id: 11, wa_message_id: "m-11", received_at: at(2), raw: { media: { key: "k" } } },
    ];
    expect(burstFollowerRows(rows, leader).map((r) => r.id)).toEqual([11]);
  });

  it("never overwrites a frame that was read on its own turn", () => {
    const rows = [
      leader,
      {
        id: 11,
        wa_message_id: "m-11",
        received_at: at(2),
        raw: { media: { key: "k" }, reading: { outcome: "read" } },
      },
    ];
    expect(burstFollowerRows(rows, leader)).toEqual([]);
  });

  it("only frames with media, only inside the burst window, never the leader", () => {
    const rows = [
      leader,
      { id: 10, wa_message_id: "m-10", received_at: at(2), raw: { media: undefined } }, // no media
      { id: 9, wa_message_id: "m-9", received_at: at(-600), raw: { media: { key: "k" } } }, // old
      { id: 11, wa_message_id: "m-11", received_at: at(1), raw: { media: { key: "k" } } },
    ];
    expect(burstFollowerRows(rows, leader).map((r) => r.id)).toEqual([11]);
  });

  it("a leader with no timestamp stamps nobody - it never guesses a burst", () => {
    const rows = [{ id: 11, wa_message_id: "m-11", received_at: at(2), raw: { media: {} } }];
    expect(burstFollowerRows(rows, { id: 12, received_at: null })).toEqual([]);
    expect(burstFollowerRows([], leader)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. Where execution is impractical (a prompt string, a provider
// response shape, a Supabase write), the pin asserts the exact line.
// ---------------------------------------------------------------------------

describe("the wiring: where each outcome is stamped", () => {
  const agents = readCode("src/lib/agents.ts");
  const loop = readCode("src/lib/agent-loop.ts");
  const ai = readCode("src/lib/ai.ts");

  it("a truncated generation is CLASSIFIED, not accepted as a good read", () => {
    // geminiVisionAttempt never inspected finishReason, so a MAX_TOKENS cut-off
    // returned non-empty PARTIAL JSON, was recorded ok:true, then failed
    // extractJson and landed in the "nothing usable" fallback (owner report 5,
    // #2).
    expect(ai).toMatch(/data\.candidates\?\.\[0\]\?\.finishReason/);
    expect(ai).toMatch(/\/\^\(MAX_TOKENS\|LENGTH\)\$\/i\.test\(finish\)/);
    expect(ai).toMatch(/failure: "truncated"/);
    // The OpenAI-shaped and Anthropic-shaped rungs speak the same contract.
    expect(ai).toMatch(/finish_reason \?\? ""\)\.toLowerCase\(\) === "length"/);
    expect(ai).toMatch(/data\.stop_reason \?\? ""\) === "max_tokens"/);
  });

  it("...and it earns ONE retry at a RAISED ceiling, via the existing gate", () => {
    expect(readCode("src/lib/vision-read.ts")).toMatch(/"truncated",\n\]\);/);
    expect(ai).toMatch(/const raise = firstFailure === "truncated" \|\| anyTruncated;/);
    expect(ai).toMatch(/return raised \? Math\.min\(8_192, Math\.round\(base \* 1\.75\)\) : base;/);
  });

  it("the re-read cannot spend a second full budget inside a 60s route", () => {
    expect(ai).toMatch(/Math\.min\(VISION_TOTAL_BUDGET_MS, opts\?\.budgetMs \?\? VISION_TOTAL_BUDGET_MS\)/);
    expect(agents).toMatch(/budgetMs: VISION_REREAD_BUDGET_MS/);
  });

  it("the prompt cannot be talked out of reading a board by crossed-out prices", () => {
    // The "REGULAR vs OFFERED" rule told the model a 'was X now Y' pair means
    // found=false and no price - and a board with struck-out old prices reads
    // exactly like that (owner report 5, #3).
    expect(agents).toMatch(/THAT RULE IS ABOUT A SENTENCE, NEVER ABOUT A PHOTO OF A BOARD/);
    expect(agents).toMatch(/never set found=false on/);
    expect(agents).toMatch(/CROSSED-OUT \/ STRUCK-THROUGH \/ OVERWRITTEN/);
    expect(agents).toMatch(/MODEL IS UNAVAILABLE/);
    expect(agents).toMatch(/NEVER quote/);
    expect(agents).toMatch(/the NEW number is the current price/);
    expect(agents).toMatch(/Crossing-out/);
    // Every tier still survives - the contract's standing rule.
    expect(agents).toMatch(/Never drop a tier\./);
  });

  it("the JSON contract asks for the fields the panel renders", () => {
    expect(agents).toMatch(/"currency": string\|null, /);
    expect(agents).toMatch(/"tierLabel": string\|null, "available": boolean\|null/);
  });

  it("the sanity net marks the reading instead of rewriting it into a lie", () => {
    expect(loop).toMatch(/modelFailure: "sanity-nulled"/);
    expect(loop).toMatch(/rejectedPricePerDay: rejected/);
    // "No usable price in this image" is a claim about the IMAGE and may only
    // be made when the image is what came up short.
    expect(loop).toMatch(/!readingIsFailure\(draft\)/);
  });

  it("telemetry can tell model-failed from photo-bad", () => {
    for (const kind of [
      "vision-unavailable",
      "vision-parse-failed",
      "vision-truncated",
      "vision-sanity-nulled",
      "vision-empty",
    ]) {
      expect(loop, kind).toMatch(new RegExp(`"${kind}"`));
    }
  });

  it("every frame of a burst is stamped, not just the turn's leader", () => {
    expect(loop).toMatch(/await stampBurstFollowers\(row, reading\)/);
    expect(loop).toMatch(/fromBurstLeader: leader\.wa_message_id \?\? String\(leader\.id\)/);
    // Privacy: the sibling scan stays receiver-scoped, like every other read.
    expect(loop).toMatch(/raw->>receiver=eq\.\$\{encodeURIComponent\(ctx\.sender\)\}/);
  });

  it("the panel prints no confidence on a failure, and marks a crossed-out row", () => {
    const c = readCode("src/components/AgenticSummary.tsx");
    expect(c).toMatch(/const failed = readingIsFailure\(reading\);/);
    expect(c).toMatch(/\{!failed && \(/);
    expect(c).toMatch(/\{\(failed \|\| empty\) && \(/);
    expect(c).toMatch(/p\.available === false/);
  });
});
