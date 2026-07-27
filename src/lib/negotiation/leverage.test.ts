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
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the plan and the rule are actually in the path", () => {
  it("the prompt is built from the ranked plan, not a fixed paragraph order", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/planLeverage\(/);
    expect(pass).toMatch(/STRONGEST FIRST/);
    // The interpolation that sent a rival's NAME to its competitor.
    expect(pass).not.toMatch(/cheaperRival\.shop/);
    // ...and the rival list the model can see carries no names either.
    expect(pass).not.toMatch(/rivals\.map\(\(r\) => `- \$\{r\.shop\}/);
  });

  it("a RAIL rejects a draft that names a rival - a prompt is not a guarantee", () => {
    const rails = readCode("src/lib/spte/rails.ts");
    expect(rails).toMatch(/rival-disclosure/);
    expect(rails).toMatch(/namesRival\(text, tokens\)/);
    // Ahead of the numeric rail's call site: identity is checked before
    // anything is rewritten.
    expect(rails.indexOf("rival-disclosure")).toBeLessThan(rails.indexOf("checkOutboundNumbers({"));
  });

  it("rivals are scoped to the SAME vehicle", () => {
    expect(readCode("src/lib/spte/live.ts")).toMatch(/sessionTable\(email, thisVendor, vehicleKeyFor/);
    expect(readCode("src/lib/graph/engine.ts")).toMatch(/vehicle_key=eq\./);
  });
});
