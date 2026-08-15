import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { readingFrom, readingHeadline, readingIsEmpty } from "./reading";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the reading is the extraction, not a description of it", () => {
  it("carries every price the board named, cheapest first", () => {
    const r = readingFrom({
      pricePerDay: 300,
      currency: "THB",
      options: [
        { pricePerDay: 600, currency: "THB", model: "Honda ADV 160" },
        { pricePerDay: 250, currency: "THB", model: "Honda Click 125", tierLabel: "6 days" },
      ],
    });
    expect(r.prices.map((p) => p.pricePerDay)).toEqual([250, 300, 600]);
    expect(r.prices[0].vehicle).toBe("Honda Click 125");
    expect(r.prices[0].tierLabel).toBe("6 days");
  });

  it("does not repeat the headline price as a second row", () => {
    const r = readingFrom({ pricePerDay: 250, options: [{ pricePerDay: 250 }] });
    expect(r.prices).toHaveLength(1);
  });

  it("collects the vehicles, the deposit and the conditions the shop stated", () => {
    const r = readingFrom({
      deposit: "Passport or 3000 THB",
      conditions: ["125cc only in Pai and Mae Hong Son", "One rider per scooter"],
      vehicleAssessment: { model: "Honda Click 125" },
      options: [{ pricePerDay: 250, model: "Honda Lead 125" }],
    });
    expect(r.deposit).toBe("Passport or 3000 THB");
    expect(r.conditions).toHaveLength(2);
    expect(r.vehicles).toEqual(["Honda Click 125", "Honda Lead 125"]);
  });

  it("records what the reading CHANGED, which is the point of showing it", () => {
    const used = readingFrom({ pricePerDay: 250 }, { usedPricePerDay: 250 });
    expect(used.usedPricePerDay).toBe(250);
    const ignored = readingFrom({ found: false }, { notUsedReason: "No usable price." });
    expect(ignored.notUsedReason).toBe("No usable price.");
  });

  it("an unreadable image is an EMPTY reading, never an invented one", () => {
    const r = readingFrom({ found: false });
    expect(readingIsEmpty(r)).toBe(true);
    expect(r.prices).toEqual([]);
    expect(readingHeadline(r)).toMatch(/nothing readable/i);
  });

  it("never throws on a malformed extraction - it is a model boundary", () => {
    expect(() => readingFrom(null)).not.toThrow();
    expect(() => readingFrom(undefined)).not.toThrow();
    expect(readingIsEmpty(readingFrom({}))).toBe(true);
    // Junk rows are dropped rather than rendered as "NaN/day".
    expect(readingFrom({ options: [{ pricePerDay: NaN }, { pricePerDay: 0 }] }).prices).toEqual([]);
  });

  it("confidence is reported, never quietly upgraded", () => {
    expect(readingFrom({ confidence: "high" }).confidence).toBe("high");
    expect(readingFrom({ confidence: "low" }).confidence).toBe("low");
    expect(readingFrom({}).confidence).toBe("medium");
  });

  it("the headline says what was found, in a phrase that fits a collapsed row", () => {
    const r = readingFrom({
      options: [{ pricePerDay: 250 }, { pricePerDay: 300 }],
      deposit: "Passport",
    });
    expect(readingHeadline(r)).toMatch(/2 prices/);
    expect(readingHeadline(r)).toMatch(/deposit terms/);
  });
});

describe("the reading reaches the traveller", () => {
  it("is stamped onto the message the media arrived on", () => {
    const a = readCode("src/lib/agent-loop.ts");
    expect(a).toMatch(/readingFrom\(extraction as never/);
    expect(a).toMatch(/raw: \{ \.\.\.\(row\.raw \?\? \{\}\), reading \}/);
    // Privacy: the no-id fallback must stay receiver-scoped, like the gloss.
    expect(a).toMatch(/raw->>receiver=eq\./);
  });

  it("is served by the transcript, and rendered under the picture", () => {
    expect(readCode("src/app/api/thread/route.ts")).toMatch(/reading: m\.raw\?\.reading/);
    const b = readCode("src/components/MessageBubble.tsx");
    // WAS: a pin on the exact gate `m.media && m.reading && <AgenticSummary`.
    // Its intent was "no panel without a reading to show" - and that intent was
    // the field failure: the picture one line above draws unconditionally, so
    // every stamp failure rendered as a photo with SILENCE under it, and the
    // traveller could not tell "still working" from "we are blind" from "the
    // panel is broken". The intent is now "an image row always explains
    // itself", and it is asserted by RENDERING the bubble
    // (src/components/AgenticSummary.test.tsx) rather than by matching source
    // text - this pin passed unchanged through the whole regression. What is
    // still worth pinning here is only the wiring: the panel gets the reading,
    // and the timestamp it needs to tell those states apart.
    expect(b).toMatch(/<AgenticSummary reading=\{m\.reading\} mediaAt=\{m\.at\} \/>/);
  });

  it("is collapsed by default, and says so when there is nothing to show", () => {
    const c = readCode("src/components/AgenticSummary.tsx");
    expect(c).toMatch(/useState\(false\)/);
    expect(c).toMatch(/readingIsEmpty\(reading\)/);
    expect(c).toMatch(/Confidence/);
  });
});
