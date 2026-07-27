import { describe, it, expect } from "vitest";
import { profileFor, mentionsClass, CLASS_PROFILES, scalesFromScooter } from "./class-profile";
import { disqualifyingKeys } from "./spec";
import { assessReply } from "./resolution";

describe("only DECLARED attributes constrain a car - the blocked funnel", () => {
  it("an undeclared seat count is not a requirement", () => {
    // The RFQ builder defaulted `seats: 4` on every car search. `seats` is a
    // DISQUALIFYING attribute, so a shop quoting a car whose seat count it did
    // not state could never be confirmed - and the quote never reached the
    // board. Every car search was blocked by a constraint nobody asked for.
    expect(disqualifyingKeys({ class: "car" })).toEqual(["class"]);
    const a = assessReply("We have a Toyota Yaris available, 900 per day", { class: "car" });
    expect(a.status).toBe("confirmed");
    expect(a.canPresent).toBe(true);
  });

  it("a DECLARED seat count still blocks a car that is too small", () => {
    // The fix must not disarm the gate: seven adults in a five-seat car is the
    // same class of error as the wrong engine size.
    const a = assessReply("We have the Toyota Vios", { class: "car", seats: 7 });
    expect(a.status).toBe("wrong-vehicle");
  });
});

describe("a class profile parameterises the funnel instead of assuming a scooter", () => {
  it("each class declares its own meaningful attributes", () => {
    expect(profileFor("car").attributes).toContain("seats");
    expect(profileFor("car").attributes).not.toContain("displacementCc");
    expect(profileFor("scooter").attributes).toContain("displacementCc");
    expect(profileFor("scooter").attributes).not.toContain("seats");
  });

  it("falls back to the scooter profile for anything unknown", () => {
    expect(profileFor(undefined).kind).toBe("scooter");
    expect(profileFor("hovercraft").kind).toBe("scooter");
  });

  it("each class carries its OWN exemplar - no scooter examples in a car turn", () => {
    expect(CLASS_PROFILES.car.exemplar.vehicle).toMatch(/car/);
    expect(CLASS_PROFILES.car.exemplar.leverage).not.toMatch(/bike|scooter/i);
  });
});

describe("'rents cars' is evidence about the SHOP, not about our query", () => {
  const car = CLASS_PROFILES.car;

  it("recognises the class from a shop's own words", () => {
    expect(mentionsClass("we have cars available sir", car)).toBe(true);
    expect(mentionsClass("Toyota Avanza 1200/day", car)).toBe(true);
    expect(mentionsClass("self-drive available", car)).toBe(true);
  });

  it("does not fire on a word that merely CONTAINS the class word", () => {
    expect(mentionsClass("ask for Carlos at the desk", car)).toBe(false);
    expect(mentionsClass("scarcity of bikes today", car)).toBe(false);
  });

  it("a scooter-only shop is not a car shop", () => {
    expect(mentionsClass("only Honda Click 125 and Nmax", car)).toBe(false);
  });
});

describe("a car is not a big scooter", () => {
  it("car buckets do NOT scale from the local scooter floor", () => {
    // They used to: every car floor was the country's 125cc scooter price times
    // a constant, which is not a car price in any market.
    expect(scalesFromScooter("scooter-125")).toBe(true);
    expect(scalesFromScooter("motorbike-300")).toBe(true);
    expect(scalesFromScooter("car-economy")).toBe(false);
    expect(scalesFromScooter("car-suv")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("every stage reads the class instead of assuming one", () => {
  it("the RFQ builder no longer invents a seat count", () => {
    expect(readCode("src/lib/agents.ts")).not.toMatch(/rfq\.seats \?\? 4/);
  });

  it("discovery records EVIDENCE of the class, separately from the query", () => {
    const g = readCode("src/lib/google.ts");
    expect(g).toMatch(/classEvidence/);
    expect(g).toMatch(/mentionsClass\(/);
  });

  it("the car floor comes from a car baseline, not a scooter multiple", () => {
    const m = readCode("src/lib/market.ts");
    expect(m).toMatch(/scalesFromScooter\(vkey\)/);
    // The ratio table no longer carries car rows at all.
    expect(m).not.toMatch(/"car-economy": 3\.6/);
  });

  it("the coach stopped teaching scooter numbers on every turn", () => {
    const g = readCode("src/lib/graph/default-graph.ts");
    expect(g).not.toMatch(/150\/day for a 125cc/);
    expect(g).not.toMatch(/170 for (the )?same bike/);
  });

  it("the 'rents cars' chip exists and is a verified tag", () => {
    expect(readCode("src/lib/vendor-tags.ts")).toMatch(/"rents-cars"/);
    expect(readCode("src/components/Filters.tsx")).toMatch(/rents-cars/);
  });
});
