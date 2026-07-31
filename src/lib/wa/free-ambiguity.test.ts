import { describe, it, expect, vi } from "vitest";

// agents.ts declares "server-only" for Next's client boundary; vitest is neither.
vi.mock("server-only", () => ({}));

import { casualize, personaHumanize, deAmbiguateFree } from "./persona";
import { claimsIn } from "../thread/claims";
import { variedFirstMessage } from "../agents";
import type { StructuredRFQ } from "../types";

// KO TAO, 31 JULY, 12:38.
//
// The agent asked a shop "is that one of the bikes you have free?" - meaning
// vacant. The shop, which had quoted 180 baht one minute earlier, replied:
//
//   "My shop doesn't have free motorcycles. You should try another shop;
//    maybe they'll give you one"
//
// That is not an out-of-stock message. It is a shop declining to give away a
// motorbike, to a customer it thought was asking for one. The word came from
// our own humanizer: CASUAL_SWAPS rewrote `available` -> `free` at 55%
// probability on every outbound message.
//
// These tests execute the real functions rather than matching source, because
// the bug was four characters inside a list that every string-matching pin in
// the suite walked straight past.

describe("we never write 'free' when we mean 'available'", () => {
  it("casualize cannot produce it, at any rand", () => {
    const src = "Is the automatic scooter available for 3 days?";
    // Sweep the whole probability space the swaps are gated on.
    for (const p of [0, 0.1, 0.3, 0.5, 0.54, 0.55, 0.6, 0.9, 0.99]) {
      expect(casualize(src, () => p)).not.toMatch(/\bfree\b/i);
    }
  });

  it("the full persona pass cannot produce it either", () => {
    for (const p of [0, 0.1, 0.3, 0.5, 0.9]) {
      const out = personaHumanize("Do you have a scooter available for 3 days?", () => p);
      expect(out).not.toMatch(/\bfree\b/i);
    }
  });

  it("REPRODUCTION: the exact field sentence is repaired before it can ship", () => {
    // Whatever composed it - LLM, template, a future swap - this is the last
    // word on the subject, because personaHumanize is the one function every
    // auto message passes through on its way to the wire.
    const shipped = personaHumanize(
      "Thanks for the options! I'm looking for a fully automatic 125cc scooter, is that one of the bikes you have free?",
      () => 0.99 // no swaps, no emoji - isolate the repair
    );
    expect(shipped).not.toMatch(/\bfree\b/i);
    expect(shipped).toContain("bikes you have spare");
  });

  it("repairs the ambiguity in every word order it actually appears in", () => {
    expect(deAmbiguateFree("do you have free scooters?")).toBe("do you have spare scooters?");
    expect(deAmbiguateFree("any bikes free tomorrow?")).toBe("any bikes spare tomorrow?");
    expect(deAmbiguateFree("is a car free for 3 days")).toBe("is a car spare for 3 days");
    // ...including at a distance, which is the shape the field message had.
    expect(deAmbiguateFree("one of the bikes you have free?")).toBe(
      "one of the bikes you have spare?"
    );
  });

  it("LEAVES REAL NO-COST OFFERS ALONE - that sense is the dominant one", () => {
    // The whole reason "free" is dangerous next to a vehicle is that no-cost is
    // how it reads. Anywhere the shop genuinely means no-cost, it must survive.
    for (const kept of [
      "we offer free delivery to your hotel",
      "free helmet with every rental",
      "cancellation is free of charge",
      "the second driver is free",
    ]) {
      expect(deAmbiguateFree(kept)).toBe(kept);
    }
  });

  it("no cold opener asks for a vehicle 'free'", () => {
    const rfq = {
      vehicleClass: "scooter",
      transmission: "automatic",
      engineSizeCc: 125,
      durationDays: 3,
      accessories: [],
    } as unknown as StructuredRFQ;
    // The pool is randomized, so sample it enough to hit every variant.
    for (let i = 0; i < 200; i++) {
      expect(variedFirstMessage(rfq)).not.toMatch(/\bfree\b/i);
    }
  });
});

describe("we never READ 'free' as an availability signal", () => {
  const shopSaid = (text: string) => claimsIn(text, "shop", 0, { force: "assert" });
  const availability = (text: string) =>
    shopSaid(text).filter((c) => c.subject === "availability");

  it("REGRESSION: 'we have bikes free' was recorded as a DENIAL", () => {
    // The trailing-"free" rule was written for "deposit free" (= no deposit)
    // and applied to every subject, so a shop confirming stock was filed as a
    // shop denying it - the exact inversion that makes an engine argue with a
    // shop that has what we want.
    const claims = availability("we have bikes free today");
    for (const c of claims) expect(c.polarity).not.toBe("denied");
  });

  it("'deposit free' still means the deposit is WAIVED", () => {
    // The rule was not deleted - it was scoped to subjects that can be waived.
    const deposit = shopSaid("deposit free for you my friend").filter(
      (c) => c.subject === "deposit"
    );
    expect(deposit.length).toBeGreaterThan(0);
    expect(deposit[0].polarity).toBe("denied");
  });

  it("a genuine out-of-stock idiom is still a denial", () => {
    for (const outOfStock of ["sorry, sold out", "we are fully booked"]) {
      const claims = availability(outOfStock);
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.some((c) => c.polarity === "denied")).toBe(true);
    }
  });

  it("KNOWN GAP, owned by F4: natural out-of-stock phrasings still miss", () => {
    // Documented rather than hidden. The cue's idiom branch is `all (rented|
    // booked|gone|taken)` - adjacent words only - so a shop writing the same
    // thing with a noun in the middle produces no claim at all. F4 rebuilds the
    // cue structurally; until then this test states the truth so the gap cannot
    // be mistaken for coverage.
    expect(availability("all bikes are rented").length).toBe(0);
  });

  it("a genuine in-stock statement is still an affirmation", () => {
    const claims = availability("I have bikes with 125cc and 150cc engines available.");
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.polarity === "affirmed")).toBe(true);
  });
});
