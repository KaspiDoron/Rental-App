import { describe, it, expect } from "vitest";
import {
  DISCLOSURE,
  answerGuide,
  disclosureBlock,
  factsAsked,
  inventsADate,
} from "./traveller-disclosure";
import type { StructuredRFQ } from "../types";

const RFQ = (over: Partial<StructuredRFQ> = {}): StructuredRFQ =>
  ({
    vehicleClass: "scooter",
    transmission: "automatic",
    durationDays: 6,
    accessories: [],
    fulfillment: "in-store",
    vendorMessage: "",
    ...over,
  }) as StructuredRFQ;

// The two questions from the live Chiang Mai thread, verbatim.
const WHEN = "Hello there , When would you like to start renting?";
const WHERE = "And where would you like to go with the bike please?";

describe("what a shop asked about the traveller", () => {
  it("recognises the two questions that produced this rule", () => {
    expect(factsAsked(WHEN)).toContain("start-date");
    expect(factsAsked(WHERE)).toContain("exact-route");
  });

  it("recognises the ones we must never answer", () => {
    expect(factsAsked("Which hotel are you staying at?")).toEqual(
      expect.arrayContaining(["address"])
    );
    expect(factsAsked("May i know your name and passport?")).toContain("identity");
    expect(factsAsked("Do you have line id or instagram?")).toContain("contact");
  });

  it("an ordinary price message asks nothing about the traveller", () => {
    expect(factsAsked("250 baht per day, ok?")).toEqual([]);
    expect(disclosureBlock({ rfq: RFQ() }, "250 baht per day, ok?")).toBe("");
  });
});

describe("the honest answer, given what the request actually holds", () => {
  it("with no date chosen, the true answer is not a day", () => {
    const [g] = answerGuide({ rfq: RFQ() }, ["start-date"]);
    expect(g.disclosure).toBe("general");
    expect(g.guidance).toMatch(/comparing prices/i);
    expect(g.guidance).toMatch(/never name a day/i);
  });

  it("with a date on file, we simply say it", () => {
    const [g] = answerGuide({ rfq: RFQ({ startDate: "2026-08-03" }) }, ["start-date"]);
    expect(g.disclosure).toBe("grounded");
    expect(g.guidance).toContain("2026-08-03");
  });

  it("the route answer is the town and nothing narrower", () => {
    const [g] = answerGuide({ rfq: RFQ(), town: "Chiang Mai" }, ["exact-route"]);
    expect(g.guidance).toContain("Chiang Mai");
    expect(g.guidance).toMatch(/never name a specific destination/i);
  });

  it("with no town consented, it stays vague rather than guessing one", () => {
    const [g] = answerGuide({ rfq: RFQ() }, ["exact-route"]);
    expect(g.guidance).toMatch(/riding around locally/i);
  });

  it("an address, a name and a second number are never ours to give", () => {
    expect(DISCLOSURE.address).toBe("withheld");
    expect(DISCLOSURE.identity).toBe("withheld");
    expect(DISCLOSURE.contact).toBe("withheld");
    for (const g of answerGuide({ rfq: RFQ() }, ["address", "identity", "contact"])) {
      expect(g.guidance).toMatch(/do not/i);
    }
  });

  it("the block appears only when something was asked, and says both halves", () => {
    const block = disclosureBlock({ rfq: RFQ(), town: "Chiang Mai" }, `${WHEN}\n${WHERE}`);
    expect(block).toMatch(/never/i);
    expect(block).toMatch(/start-date/);
    expect(block).toMatch(/exact-route/);
  });
});

describe("the rail: a date the traveller never chose", () => {
  it("rejects an invented weekday", () => {
    expect(inventsADate("Great - I'll start Tuesday then!", RFQ())).toBe(true);
    expect(inventsADate("Perfect, see you on 3rd Aug", RFQ())).toBe(true);
  });

  it("lets the date the traveller DID choose through", () => {
    const rfq = RFQ({ startDate: "2026-08-03" });
    expect(inventsADate("Starting 2026-08-03, is that ok?", rfq)).toBe(false);
  });

  it("a different date is still invented even when one is on file", () => {
    expect(inventsADate("I'll come Friday", RFQ({ startDate: "2026-08-03" }))).toBe(true);
  });

  it("the honest non-answer passes", () => {
    expect(
      inventsADate("Still comparing prices today - I'll fix the dates once I pick a shop.", RFQ())
    ).toBe(false);
  });

  it("today and tomorrow are about our availability, not a booking", () => {
    // The rental-window authority (lib/rental-window) already governs those.
    expect(inventsADate("Could I pick it up today?", RFQ())).toBe(false);
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

describe("both halves of report 11 are structural, not prompt advice", () => {
  it("the turn prompt carries the disclosure guidance", () => {
    const p = readCode("src/lib/spte/pass.ts");
    expect(p).toMatch(/disclosureBlock\(/);
    expect(p).toMatch(/aboutYouBlock \+/);
  });

  it("a rail refuses a draft that invents a date", () => {
    const r = readCode("src/lib/spte/rails.ts");
    expect(r).toMatch(/inventsADate\(text, ctx\.session\.rfq\)/);
    expect(r).toMatch(/rule: "traveller-disclosure"/);
  });

  it("a deposit is not owed until a price exists", () => {
    const l = readCode("src/lib/thread/ledger.ts");
    expect(l).toMatch(/OBLIGATION_AFTER/);
    expect(l).toMatch(/deposit: "price"/);
    expect(l).toMatch(/handover: "price"/);
    const p = readCode("src/lib/spte/policy.ts");
    // The engine's own facts, as well as the thread's text: a price read off a
    // photo never becomes a text claim, and a deposit question is just as
    // premature either way.
    expect(p).toMatch(/gated\.length === 0 && priceKnown/);
  });
});
