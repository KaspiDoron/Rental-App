import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { readingFrom, readingIsEmpty, readingHeadline } from "./reading";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// "NOTHING READABLE IN THIS ONE" ON A PERFECTLY READ IMAGE.
//
// A shop sent a crisp product card - "Honda Click 125 v3 / 300 THB / DAY /
// 1750 THB / 7 DAYS" - and the proof panel told the traveller the agents could
// not read it. The agents had read it. This shape declared `visionText` and
// `conditions`, and ExtractedOffer has never had either field: it emits
// `imageSummary` and `conditionNotes`. Both reads were permanently undefined,
// and `readingIsEmpty` requires prices AND vehicles AND deposit AND conditions
// AND text to all be empty - so any extraction without a parsed price reported
// as blind.

describe("the reading reads the fields the extractor actually writes", () => {
  it("a summary with no parsed price is NOT 'nothing readable'", () => {
    const r = readingFrom(
      {
        imageSummary: "Honda Click 125 v3, grey, 300 THB per day, 1750 THB for 7 days",
      },
      {}
    );
    expect(readingIsEmpty(r)).toBe(false);
    expect(r.text).toMatch(/Honda Click/);
    expect(readingHeadline(r)).not.toBe("Nothing readable in this one");
  });

  it("condition notes survive as conditions", () => {
    const r = readingFrom({ conditionNotes: "helmet included; fuel not included" }, {});
    expect(r.conditions).toEqual(["helmet included", "fuel not included"]);
    expect(readingIsEmpty(r)).toBe(false);
  });

  it("a genuinely blank extraction is still reported as blank", () => {
    // The empty state must keep working - this is a correctness fix, not a
    // way of always claiming success.
    expect(readingIsEmpty(readingFrom({}, {}))).toBe(true);
    expect(readingHeadline(readingFrom({}, {}))).toBe("Nothing readable in this one");
  });

  it("the vehicle description is a last-resort source of text", () => {
    const r = readingFrom({ vehicleDescription: "automatic scooter, 125cc" }, {});
    expect(r.text).toMatch(/125cc/);
  });

  it("the legacy field names still work, so the studio mirrors keep running", () => {
    const r = readingFrom({ visionText: "old shape", conditions: ["a", "b"] }, {});
    expect(r.text).toBe("old shape");
    expect(r.conditions).toEqual(["a", "b"]);
  });

  it("prices still lead the headline when there are any", () => {
    const r = readingFrom(
      { options: [{ pricePerDay: 300, currency: "THB" }], imageSummary: "board" },
      {}
    );
    expect(readingHeadline(r)).toMatch(/1 price/);
  });
});

describe("the shape is pinned to the extractor's real field names", () => {
  it("ExtractedOffer has imageSummary and conditionNotes, not visionText", () => {
    const agents = read("src/lib/agents.ts");
    expect(agents).toMatch(/imageSummary\?: string \| null;/);
    expect(agents).toMatch(/conditionNotes\?: string \| null;/);
    // The name the reading used to look for does not exist on the extractor.
    expect(agents).not.toMatch(/\bvisionText\?:/);
  });

  it("...and the reading consumes those names", () => {
    const r = read("src/lib/media/reading.ts");
    expect(r).toMatch(/clean\(e\.imageSummary\)/);
    expect(r).toMatch(/e\.conditionNotes/);
  });
});
