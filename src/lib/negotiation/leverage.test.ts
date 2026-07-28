import { describe, it, expect } from "vitest";
import {
  planLeverage,
  leadCard,
  cheapestCheaperRival,
  rivalIdentityTokens,
  namesRival,
} from "./leverage";

const base = {
  durationDays: 4,
  round: 0,
  vehicleLabel: "automatic 125cc scooter",
  currency: "THB",
};

describe("the strongest card leads - report #6, the major one", () => {
  it("a live cheaper rival outranks the duration lever on the FIRST push", () => {
    // The old directive hard-coded "use the N-day rental as your reason" onto
    // the first push, so the strongest card in the negotiation was played late
    // or never - and many threads never got a later push.
    const plan = planLeverage({
      ...base,
      quotePerDay: 300,
      rivals: [{ pricePerDay: 250, currency: "THB", shop: "Marlin Krabi" }],
    });
    expect(leadCard(plan)?.kind).toBe("rival");
    expect(plan.map((c) => c.kind).indexOf("duration")).toBeGreaterThan(0);
  });

  it("a bigger gap is stronger leverage than a smaller one", () => {
    const near = planLeverage({ ...base, quotePerDay: 300, rivals: [{ pricePerDay: 290 }] });
    const far = planLeverage({ ...base, quotePerDay: 300, rivals: [{ pricePerDay: 180 }] });
    expect(far[0].strength).toBeGreaterThan(near[0].strength);
  });

  it("duration leads only when there is nothing stronger", () => {
    const plan = planLeverage({ ...base, quotePerDay: 300, rivals: [] });
    expect(leadCard(plan)?.kind).toBe("duration");
  });

  it("duration weakens once it has been played", () => {
    const first = planLeverage({ ...base, quotePerDay: 300, rivals: [], round: 0 });
    const later = planLeverage({ ...base, quotePerDay: 300, rivals: [], round: 2 });
    const d = (p: ReturnType<typeof planLeverage>) => p.find((c) => c.kind === "duration")!.strength;
    expect(d(later)).toBeLessThan(d(first));
  });

  it("a MORE EXPENSIVE rival is not leverage - it is the shop's own argument", () => {
    expect(cheapestCheaperRival([{ pricePerDay: 400 }], 300)).toBeNull();
    const plan = planLeverage({ ...base, quotePerDay: 300, rivals: [{ pricePerDay: 400 }] });
    expect(plan.some((c) => c.kind === "rival")).toBe(false);
  });

  it("with no quote on the table there is no rival card to play", () => {
    expect(cheapestCheaperRival([{ pricePerDay: 250 }], undefined)).toBeNull();
  });

  it("the cheapest cheaper rival wins, not merely the first", () => {
    expect(
      cheapestCheaperRival([{ pricePerDay: 280 }, { pricePerDay: 220 }], 300)?.pricePerDay
    ).toBe(220);
  });
});

describe("the rival card carries the price and the vehicle - never the name", () => {
  it("the line names the vehicle and the price, and no shop", () => {
    const plan = planLeverage({
      ...base,
      quotePerDay: 300,
      rivals: [{ pricePerDay: 250, currency: "THB", shop: "Marlin Krabi" }],
    });
    const line = leadCard(plan)!.line;
    expect(line).toContain("250");
    expect(line).toContain("automatic 125cc scooter");
    expect(line).not.toContain("Marlin");
    expect(line).toMatch(/NEVER name/i);
  });
});

describe("the disclosure rail knows what a shop's identity looks like", () => {
  const tokens = rivalIdentityTokens(["Marlin Krabi Motorbike Rental", "Joh's Matics"]);

  it("catches the shop's distinctive words and its full name", () => {
    expect(namesRival("Another shop, Marlin, quoted me 250", tokens)).toBe("marlin");
    expect(namesRival("marlin krabi motorbike rental has 250", tokens)).toBeTruthy();
    expect(namesRival("I saw 250 at Matics", tokens)).toBe("matics");
  });

  it("does NOT reject an innocent draft over a generic word", () => {
    // "rental", "motorbike", "shop" appear in every shop name and in every
    // message - matching on them would reject every draft we ever send.
    expect(namesRival("Could you do a better rental price for the motorbike?", tokens)).toBeNull();
    expect(namesRival("I have a better offer at 250/day for this scooter", tokens)).toBeNull();
  });

  it("matches on word boundaries, not substrings", () => {
    const t = rivalIdentityTokens(["Sunrise Bikes"]);
    expect(namesRival("the sunrise is at 6am", t)).toBe("sunrise");
    expect(namesRival("sunrisers are nice", t)).toBeNull();
  });

  it("is empty-safe", () => {
    expect(rivalIdentityTokens([undefined, "", "a"])).toEqual([]);
    expect(namesRival("anything", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE GUARANTEES.
//
// These were assertions about the SOURCE of pass.ts, rails.ts, live.ts and
// engine.ts - that one file contained the substring "STRONGEST FIRST" and
// another mentioned `namesRival(text, tokens)` before `checkOutboundNumbers({`.
// A grep over source is not a test of behaviour: it passes while the module
// misbehaves, and it fails when a correct redesign renames a local. What the
// three of them were reaching for is expressed here as properties of the plan
// itself, which is the artifact those files consume.
// ---------------------------------------------------------------------------

describe("the plan itself carries the guarantees", () => {
  const rivalShops = ["Marlin Krabi Motorbike Rental", "Joh's Matics", "Sunrise Bikes"];

  it("is ranked strongest-first for every shape of input, not paragraph order", () => {
    // Whatever the caller renders, it renders IN THIS ORDER - so ordering is the
    // plan's job and no template can put the weakest card first again.
    for (const round of [0, 1, 3]) {
      for (const rivals of [[], [{ pricePerDay: 290 }], [{ pricePerDay: 180 }], [{ pricePerDay: 400 }]]) {
        const plan = planLeverage({ ...base, quotePerDay: 300, round, rivals });
        const strengths = plan.map((c) => c.strength);
        expect(strengths).toEqual([...strengths].sort((a, b) => b - a));
        if (plan.length) expect(leadCard(plan)).toBe(plan[0]);
      }
    }
  });

  it("nothing the model is handed can name a rival - the leak is impossible, not forbidden", () => {
    // The prompt used to interpolate the rival's shop name and order the model
    // to use it, so the cheaper shop's identity went to its direct competitor
    // from the traveller's own number. The rail is the belt; this is the fact
    // that there is nothing to leak in the first place.
    const tokens = rivalIdentityTokens(rivalShops);
    for (const round of [0, 2]) {
      const plan = planLeverage({
        ...base,
        quotePerDay: 300,
        round,
        rivals: rivalShops.map((shop, i) => ({ pricePerDay: 250 - i * 10, currency: "THB", shop })),
      });
      expect(plan.length).toBeGreaterThan(0);
      for (const card of plan) expect(namesRival(card.line, tokens)).toBeNull();
    }
  });

  it("the rival card is the price and the vehicle, and says so", () => {
    const plan = planLeverage({
      ...base,
      quotePerDay: 300,
      rivals: [{ pricePerDay: 250, currency: "THB", shop: "Marlin Krabi" }],
    });
    const card = plan.find((c) => c.kind === "rival")!;
    expect(card.line).toContain("250");
    expect(card.line).toContain(base.vehicleLabel);
    expect(card.line).toMatch(/never name/i);
  });

  it("the rail's predicate catches the ways a draft actually names a shop", () => {
    // A prompt is advice and a rail is a guarantee - but the guarantee is only
    // as good as this predicate, so it is tested as the rail uses it: over a
    // draft, with the tokens of the shops in the session.
    const tokens = rivalIdentityTokens(rivalShops);
    for (const draft of [
      "Another shop, Marlin, quoted me 250 for the same scooter",
      "I have 250 at marlin krabi motorbike rental",
      "Sunrise Bikes will do 240.",
      "matics offered 250/day",
    ]) {
      expect(namesRival(draft, tokens)).toBeTruthy();
    }
    expect(namesRival("I have a better offer at 250/day for this scooter", tokens)).toBeNull();
  });

  it("the card is scoped to ONE vehicle, and the vehicle is in the words", () => {
    // A rival quote only means anything for the same vehicle. The caller does
    // the scoping when it queries; the card makes the scope visible, so a quote
    // for another bike cannot be passed off as "the same" one silently.
    const scooter = planLeverage({ ...base, quotePerDay: 300, rivals: [{ pricePerDay: 250 }] });
    const car = planLeverage({
      ...base,
      vehicleLabel: "small automatic car",
      quotePerDay: 300,
      rivals: [{ pricePerDay: 250 }],
    });
    expect(leadCard(scooter)!.line).toContain("automatic 125cc scooter");
    expect(leadCard(car)!.line).toContain("small automatic car");
    expect(leadCard(car)!.line).not.toContain("scooter");
  });

  it("a rival with no usable price is not a card", () => {
    expect(cheapestCheaperRival([{ pricePerDay: undefined as unknown as number }], 300)).toBeNull();
    expect(
      planLeverage({
        ...base,
        quotePerDay: 300,
        rivals: [{ pricePerDay: null as unknown as number }],
      }).some((c) => c.kind === "rival")
    ).toBe(false);
  });
});
