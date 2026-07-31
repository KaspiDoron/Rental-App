import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { claimsIn } from "../thread/claims";
import { stockState } from "../thread/ledger";
import { moveGlossary, normalizeMove } from "./moves";

// KO TAO, 12:38-12:43. The whole failure in four lines:
//
//   12:22  shop: "I can give you 180 baht for one day."
//   12:38  shop: "My shop doesn't have free motorcycles. You should try
//                 another shop; maybe they'll give you one"
//   12:39  us:   "That's a bit high for me..."
//   12:43  us:   "great, 180 baht per day is a good price!"
//
// Three separate defects lined up. The shop's out-of-stock sentence produced
// NO claim (the cue could not see an adjective between the verb and the noun),
// so the message read as a plain decline; `declined` was evaluated before
// `shopUnavailable`, so the decline branch ran and made `close` legal; and the
// model, given a bare `LEGAL MOVES: close, silent` and no glossary, read
// "close" as close the deal.
//
// Each is fixed at its own layer, and each is pinned here.

const availability = (text: string) =>
  claimsIn(text, "shop", "2026-07-31T05:38:00.000Z", { force: "assert" }).filter(
    (c) => c.subject === "availability"
  );

describe("the sentence that started it is now read", () => {
  it("REPRODUCTION: 'My shop doesn't have free motorcycles' is an availability DENIAL", () => {
    const claims = availability("My shop doesn't have free motorcycles.");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.polarity === "denied")).toBe(true);
  });

  it("an adjective between the verb and the noun no longer hides the fact", () => {
    // The old rule allowed `a|an|any|one|the` and nothing else, so every one of
    // these produced zero claims. Shops write like this constantly.
    for (const s of [
      "we don't have automatic scooters today",
      "no 125cc bikes left",
      "sorry, we have no more scooters",
      "I don't have any small motorbikes right now",
    ]) {
      const claims = availability(s);
      expect(claims.length, s).toBeGreaterThan(0);
      expect(claims.some((c) => c.polarity === "denied"), s).toBe(true);
    }
  });

  it("every word for the vehicle counts, in either word order", () => {
    // The possession branch knew about motorcycles and automatics; the
    // noun-adjacent branch did not. One vocabulary now serves both.
    for (const s of ["no motorcycles available", "mopeds are all gone", "automatics are ready"]) {
      expect(availability(s).length, s).toBeGreaterThan(0);
    }
  });

  it("A PREPOSITION STILL BREAKS IT - this is not a wildcard", () => {
    // The modifier run is bounded and refuses prepositions on purpose: past
    // one, the noun belongs to a different phrase and the sentence is not a
    // claim about stock at all.
    expect(availability("I have a photo of the bikes").length).toBe(0);
    expect(availability("we have a parking place for cars").length).toBe(0);
  });

  it("a shop confirming stock is still an affirmation, not a denial", () => {
    const claims = availability("Yes we have automatic scooters available today");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.polarity === "affirmed")).toBe(true);
  });
});

describe("one message, two claims: the denial decides", () => {
  const at = "2026-07-31T05:38:00.000Z";
  const claim = (polarity: "affirmed" | "denied") => ({
    subject: "availability" as const,
    actor: "shop" as const,
    polarity,
    force: "assert" as const,
    details: [],
    evidence: polarity,
    at,
  });

  it("identical timestamps no longer let array order pick the answer", () => {
    // "no scooters today, bikes available tomorrow" is two claims stamped
    // the same. Whichever the scanner emitted last used to win.
    const bothWays = [
      [claim("affirmed"), claim("denied")],
      [claim("denied"), claim("affirmed")],
    ];
    for (const claims of bothWays) {
      expect(
        stockState({ claims, known: [], outstanding: [], owed: [] }).state
      ).toBe("out-of-stock");
    }
  });

  it("a genuinely LATER restock still un-sticks the state", () => {
    const later = { ...claim("affirmed"), at: "2026-07-31T06:00:00.000Z" };
    expect(
      stockState({ claims: [claim("denied"), later], known: [], outstanding: [], owed: [] }).state
    ).toBe("in-stock");
  });
});

describe("out of stock outranks a decline", () => {
  it("the stock branch is evaluated BEFORE the decline branch", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "src/lib/spte/policy.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const stock = src.indexOf("if (v.shopUnavailable)");
    const declined = src.indexOf("if (v.declined)");
    expect(stock).toBeGreaterThan(0);
    expect(declined).toBeGreaterThan(0);
    // A message that reads as both must take the branch that keeps the thread
    // alive. This ordering IS the rule - there is nowhere else it lives.
    expect(stock).toBeLessThan(declined);
  });
});

describe("the move is named what it means", () => {
  it("a farewell is defined for the model, in the model's own prompt", () => {
    const g = moveGlossary(["farewell", "silent"]);
    expect(g).toMatch(/farewell:/);
    expect(g).toMatch(/NOT an agreement/i);
    expect(g).toMatch(/never state a price/i);
    expect(g).toMatch(/silent:/);
  });

  it("the OLD name is still accepted on the way in", () => {
    // Model output coached by a pre-rename exemplar, an owner correction in
    // ops_learning, a golden case row: all three still say "close". Coercing
    // that to legal[0] would throw away a choice that was right.
    expect(normalizeMove("close")).toBe("farewell");
    expect(normalizeMove(" close ")).toBe("farewell");
    // ...and nothing else is rewritten.
    expect(normalizeMove("bargain")).toBe("bargain");
    expect(normalizeMove("redirect-close")).toBe("redirect-close");
    expect(normalizeMove(undefined)).toBe("");
  });
});
