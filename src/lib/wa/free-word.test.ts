import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { deAmbiguateFree } from "./persona";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// KO TAO, 12:22 -> 12:38. The shop quoted 180 baht. We asked "is that one of
// the bikes you have free?" meaning vacant. The shop read it as asking for a
// motorbike at no charge, said it had none free, and told us to try elsewhere.
// We then agreed 180 with a shop that had just withdrawn.
//
// The persona swap that produced it was deleted - and the word came straight
// back through a DETERMINISTIC FALLBACK TEMPLATE ("Do you know when one might
// be free again?"), which fires precisely when the LLM is unavailable. A rail
// tuned to the exact sentence that hurt us is not a fix; it is a bookmark.

describe("the vacancy sense never survives to the wire", () => {
  it("REPRODUCTION: the restock-probe fallback no longer says it", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).not.toMatch(/might be free again/);
    expect(pass).toMatch(/back in stock/);
  });

  it("the shapes the field produced are still rewritten", () => {
    expect(deAmbiguateFree("is that one of the bikes you have free?")).toMatch(/have spare/);
    expect(deAmbiguateFree("do you have free scooters")).toMatch(/spare scooters/);
    expect(deAmbiguateFree("any cars free tomorrow?")).toMatch(/cars spare/);
  });

  it("...and the predicative shapes the template used", () => {
    expect(deAmbiguateFree("when will one be free again?")).not.toMatch(/\bfree\b/);
    expect(deAmbiguateFree("let me know when one is free")).toMatch(/one is available/);
    expect(deAmbiguateFree("if any are free tomorrow")).toMatch(/any are available/);
  });

  it("a genuine no-cost offer is left completely alone", () => {
    // The whole point: "free" IS the right word for something included.
    expect(deAmbiguateFree("we have free delivery")).toBe("we have free delivery");
    expect(deAmbiguateFree("includes a free helmet")).toBe("includes a free helmet");
    expect(deAmbiguateFree("free of charge")).toBe("free of charge");
    expect(deAmbiguateFree("delivery is free")).toBe("delivery is free");
  });
});

describe("taught, not just corrected", () => {
  it("the composer is told what the word does to a shop owner", () => {
    // A rail catches the shapes we have seen. Only the model can avoid the
    // ones we have not.
    // The prompt lives in a TS string literal, so the quotes around the word
    // are escaped in the source - match them as written, not as rendered.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/NEVER use the word \\"free\\" to mean available\/vacant\/in stock/);
    expect(pass).toMatch(/asking for a free /);
  });

  it("and so is the translator, because the English rail never runs there", () => {
    // localizeMessage deliberately skips persona, so an ambiguous English
    // source carries the wrong sense straight into Thai.
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/If the English says \\"free\\" about a VEHICLE/);
    expect(agents).toMatch(/never at no cost/);
  });
});
