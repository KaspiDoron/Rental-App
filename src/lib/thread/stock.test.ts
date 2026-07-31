import { describe, it, expect } from "vitest";
import { claimsIn } from "./claims";
import { buildLedger, stockState } from "./ledger";
import { cheapestPresentable } from "../offer-presentation";

const ledgerOf = (shopSaid: string[], weSaid: string[] = []) =>
  buildLedger({ inbound: shopSaid, outbound: weSaid });

// THE FIELD FAILURE, verbatim: a Ko Pha-ngan shop wrote "Now I don't have
// bike." and the app had nowhere to put it. The availability cue needed the
// pronoun ("we have"), so a negated bare "have bike" produced no claim at all -
// no state, no card, no move. The agent kept haggling over a scooter that did
// not exist and the traveller kept waiting for a price.
describe("a shop with no vehicle is SAYING something", () => {
  it("THE FIELD STRING: 'Now I don't have bike.' is a denied availability claim", () => {
    const [c] = claimsIn("Now I don't have bike.", "shop", 0);
    expect(c?.subject).toBe("availability");
    expect(c?.polarity).toBe("denied");
  });

  it("reads the shapes shops actually use, in both polarities", () => {
    const read = (s: string) => {
      const c = claimsIn(s, "shop", 0).find((x) => x.subject === "availability");
      return c?.polarity;
    };
    expect(read("we have bike ready today")).toBe("affirmed");
    expect(read("yes available")).toBe("affirmed");
    expect(read("no scooter left")).toBe("denied");
    expect(read("all rented until Friday")).toBe("denied");
    // INHERENTLY NEGATIVE IDIOMS carry no negator for the scope rule to find -
    // without the negativeCue they read as a shop CONFIRMING it had stock.
    expect(read("sold out")).toBe("denied");
    expect(read("fully booked")).toBe("denied");
  });

  it("does not mistake other logistics talk for a stock claim", () => {
    const c = claimsIn("we deliver to your hotel", "shop", 0);
    expect(c.map((x) => x.subject)).not.toContain("availability");
  });
});

describe("stockState reads the shop's LAST word", () => {
  it("out of stock, with the restock words when they gave any", () => {
    const s = stockState(ledgerOf(["Sorry, sold out today - maybe tomorrow"]));
    expect(s.state).toBe("out-of-stock");
    expect(s.restockHint).toMatch(/tomorrow/i);
  });

  it("A RESTOCK UN-STICKS IT with no special case", () => {
    // The later claim wins, exactly like every other fact in the ledger.
    const s = stockState(ledgerOf(["no bike today", "we have bike now, 250 per day"]));
    expect(s.state).toBe("in-stock");
  });

  it("silence on the subject is 'unknown', never a guess", () => {
    expect(stockState(ledgerOf(["125cc is 250 per day"])).state).toBe("unknown");
    expect(stockState(undefined).state).toBe("unknown");
  });
});

describe("an unavailable shop never wears BEST PRICE", () => {
  const offer = (pricePerDay: number) => ({
    pricePerDay,
    currency: "THB",
    matchesSpec: true,
    vehicleStatus: "confirmed" as const,
  });

  it("the cheapest AVAILABLE shop wins, not the cheapest out-of-stock one", () => {
    const best = cheapestPresentable(
      [
        { id: "gone", offer: offer(180), stage: "out-of-stock" },
        { id: "live", offer: offer(220), stage: "offer-received" },
      ],
      "THB"
    );
    expect(best?.id).toBe("live");
  });

  it("...and the price itself is not deleted - the card still shows it", () => {
    // Exclusion is a presentation rule, not a data one: isPresentableOffer is
    // untouched, so the card keeps rendering the quote with its honest state.
    const best = cheapestPresentable([{ id: "gone", offer: offer(180) }], "THB");
    expect(best?.id).toBe("gone");
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

describe("out of stock is a state everywhere, not just a claim", () => {
  it("the engine stops haggling and asks ONE restock question", () => {
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/v\.shopUnavailable/);
    expect(policy).toMatch(/restock-probe/);
    expect(policy).toMatch(/alreadyAskedStock/);
    // The probe is a fact-question, so the ask-once ledger gate covers it.
    expect(policy).toMatch(/"restock-probe": "availability"/);
  });

  it("the ack is warm, seeded, and asks when one is back", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/case "restock-probe"/);
    expect(pass).toMatch(/available again|back\?/);
  });

  it("the fact is durable and reaches the client", () => {
    expect(readCode("src/lib/graph/state.ts")).toMatch(/f\.shopUnavailable = /);
    expect(readCode("src/app/api/replies/route.ts")).toMatch(/unavailable: st\?\.shopUnavailable/);
    expect(readCode("src/app/page.tsx")).toMatch(/out-of-stock/);
  });

  it("the tracker has a real stage with its own honest caption", () => {
    const tracker = readCode("src/components/Tracker.tsx");
    expect(tracker).toMatch(/"out-of-stock": \{/);
    expect(tracker).toMatch(/asked when one is back/);
    expect(readCode("src/lib/types.ts")).toMatch(/\| "out-of-stock"/);
  });
});
