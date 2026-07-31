import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const agents = readCode("src/lib/agents.ts");

// A dense, low-contrast or badly-lit board is the case where a single vision
// pass reliably under-reads: the model answers from the rows it attended to and
// the rest are simply absent - which is how a real Thai board came back with no
// usable row at all.
describe("the region-directed re-read (multi-crop, without pixels)", () => {
  it("fires ONLY on a price board that yielded nothing usable", () => {
    // A good first read must never be spent on a second call, and a positively
    // WRONG vehicle must not be re-read into an offer.
    expect(agents).toMatch(/const boardMissed =/);
    expect(agents).toMatch(/first\.imageKind === "price_sheet"/);
    expect(agents).toMatch(/!first\.found/);
    expect(agents).toMatch(/first\.vehicleVerdict !== "mismatch"/);
  });

  it("directs ATTENTION region by region and transcribes before extracting", () => {
    expect(agents).toMatch(/TOP third, then MIDDLE, then BOTTOM/);
    expect(agents).toMatch(/transcribe EVERY line you can see verbatim/);
    expect(agents).toMatch(/faint, /);
    expect(agents).toMatch(/handwritten/);
  });

  it("adopts the second read ONLY when it recovered something", () => {
    expect(agents).toMatch(/if \(second\.found \|\| \(second\.options\?\.length \?\? 0\) > 0\)/);
    // ...and a failed re-read keeps the first result rather than losing it.
    expect(agents).toMatch(/return \{ \.\.\.first, imageRead \};/);
  });

  it("does not pull in an image library - the runtime has none", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const heavy of ["sharp", "jimp", "canvas", "@napi-rs/canvas", "tesseract.js"]) {
      expect(deps).not.toContain(heavy);
    }
  });
});

describe("visual vehicle classification", () => {
  it("is a CLOSED vocabulary, answered from the picture alone", () => {
    expect(agents).toMatch(/"seenVehicleClass": "scooter"\|"motorbike"\|"car"\|"unclear"\|null/);
    expect(agents).toMatch(/NEVER infer it from the caption or the model name/);
    // Anything outside the set is "we could not tell", never a guess.
    expect(agents).toMatch(
      /\["scooter", "motorbike", "car", "unclear"\]\.includes\(e\.seenVehicleClass\)/
    );
  });

  it("downgrades a confident match to UNCLEAR, never straight to mismatch", () => {
    // A shop may simply have sent a photo of another bike it also rents; the
    // honest response is to ask, which is what "unclear" produces.
    expect(agents).toMatch(/verdict === "match" &&\s*e\.seenMatchesRequest === false/);
    expect(agents).toMatch(/vehicleVerdict: "unclear", matchesSpec: true/);
  });

  it("only fires when the model actually judged the pixels", () => {
    expect(agents).toMatch(/e\.seenVehicleClass !== "unclear"/);
  });
});
