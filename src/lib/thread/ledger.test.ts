import { describe, it, expect } from "vitest";
import { claimsIn, latestClaim, settled } from "./claims";
import { buildLedger, alreadyAsked, unaskedObligations } from "./ledger";

// The live reply that broke three things at once. The shop is offering the best
// terms in the thread and the app read it as a scam AND as a passport deposit.
const NO_DEPOSIT = "No deposit needed sir, just your passport at pickup";

describe("polarity: a denial is not the thing it denies", () => {
  it("'no deposit' is a DENIED deposit claim, not an affirmed one", () => {
    const c = latestClaim(claimsIn(NO_DEPOSIT, "shop", 0), "deposit");
    expect(c?.polarity).toBe("denied");
  });

  it("the negation is scoped to its clause - the passport claim stands alone", () => {
    // The old code had an `else`: no literal "no deposit" -> any "passport"
    // became a passport deposit. Scope is what keeps the two apart.
    const claims = claimsIn(NO_DEPOSIT, "shop", 0);
    const handover = claims.find((c) => c.subject === "handover");
    expect(handover?.polarity).toBe("affirmed");
    expect(handover?.detail).toBe("pickup");
  });

  it("reads every way a shop says the same thing", () => {
    for (const phrase of [
      "we don't take a deposit",
      "no deposit required",
      "deposit free",
      "without deposit",
      "we do not need any deposit",
    ]) {
      expect(latestClaim(claimsIn(phrase, "shop", 0), "deposit")?.polarity).toBe("denied");
    }
  });

  it("still reads a REAL deposit as required", () => {
    const c = latestClaim(claimsIn("Deposit 3000 baht cash", "shop", 0), "deposit");
    expect(c?.polarity).toBe("affirmed");
    expect(c?.detail).toBe("cash");
    const p = latestClaim(claimsIn("We keep your passport as deposit", "shop", 0), "deposit");
    expect(p?.polarity).toBe("affirmed");
    expect(p?.detail).toBe("passport");
  });

  it("a denial SETTLES the question - it is not 'still unknown'", () => {
    // The old boolean only counted an affirmed deposit, so the friendliest terms
    // in the thread read as "deposit unknown" and got asked about forever.
    expect(settled(claimsIn(NO_DEPOSIT, "shop", 0), "deposit")).toBe(true);
  });
});

describe("asked: the same question does not go out twice", () => {
  it("an unanswered question is OUTSTANDING", () => {
    const l = buildLedger({
      inbound: ["Hello sir"],
      outbound: ["Could you share your best price per day for the 4 days?"],
    });
    expect(alreadyAsked(l, "price")).toBe(true);
  });

  it("an ANSWERED question is not outstanding - we can ask again later", () => {
    const l = buildLedger({
      inbound: ["Hello sir", "500 per day"],
      outbound: ["Could you share your best price per day?"],
    });
    expect(alreadyAsked(l, "price")).toBe(false);
  });

  it("a statement is not a question", () => {
    const l = buildLedger({
      inbound: [],
      outbound: ["Hi! I'm looking for an automatic 125cc scooter for 4 days."],
    });
    expect(l.outstanding).toEqual([]);
  });
});

describe("owed: a thread cannot go quiet owing the traveller a fact", () => {
  it("deposit and handover are owed until the shop settles them", () => {
    const l = buildLedger({ inbound: ["500 per day sir"], outbound: [] });
    expect(l.owed).toContain("deposit");
    expect(l.owed).toContain("handover");
  });

  it("a DENIED deposit discharges the obligation just like a stated one", () => {
    const l = buildLedger({ inbound: [NO_DEPOSIT], outbound: [] });
    expect(l.owed).not.toContain("deposit");
    expect(l.owed).not.toContain("handover"); // "at pickup" settled that too
  });

  it("an obligation we have already asked about is not asked again", () => {
    const l = buildLedger({
      inbound: ["500 per day"],
      outbound: ["What's the deposit?"],
    });
    expect(l.owed).toContain("deposit");
    expect(unaskedObligations(l)).not.toContain("deposit");
    expect(unaskedObligations(l)).toContain("handover");
  });
});

describe("the ledger is total and never throws", () => {
  it("handles an empty thread", () => {
    const l = buildLedger({ inbound: [], outbound: [] });
    expect(l.claims).toEqual([]);
    expect(l.outstanding).toEqual([]);
    // ...and owes NOTHING yet. A deposit is a term of a price, so before the
    // shop has quoted anything it is not this thread's turn to ask - which is
    // the live "could you let me know your deposit?" that went to a shop whose
    // only message was an opening-hours auto-reply.
    expect(l.owed).toEqual([]);
  });

  it("an obligation comes due only once its prerequisite is settled", () => {
    const before = buildLedger({ inbound: ["Thanks for messaging us!"], outbound: [] });
    expect(before.owed).toEqual([]);
    const after = buildLedger({ inbound: ["250 baht per day"], outbound: [] });
    expect(after.owed).toContain("deposit");
    expect(after.owed).toContain("handover");
  });

  it("does not double-count the just-arrived message", () => {
    const a = buildLedger({ inbound: ["500 per day"], currentInbound: "500 per day", outbound: [] });
    const b = buildLedger({ inbound: ["500 per day"], outbound: [] });
    expect(a.claims.length).toBe(b.claims.length);
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

describe("the ledger reaches the decisions it exists for", () => {
  it("the engine derives it every turn, alongside the other thread facts", () => {
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/buildLedger\(/);
    // A denial settles the question, so the old boolean is OR-ed with it.
    expect(live).toMatch(/ledger\.known\.includes\("deposit"\)/);
    expect(live).toMatch(/ledger\.known\.includes\("handover"\)/);
  });

  it("repeating an outstanding question is ILLEGAL, not merely discouraged", () => {
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/withoutRepeatedAsks/);
    expect(policy).toMatch(/alreadyAsked/);
    // A bargain is a push, not a fact question - it is deliberately not gated.
    expect(policy).not.toMatch(/QUESTION_SUBJECT[\s\S]{0,120}bargain:/);
  });

  it("an unmet, unasked obligation outranks falling silent", () => {
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/unaskedObligations/);
    expect(policy.indexOf("unaskedObligations")).toBeLessThan(
      policy.indexOf('gated.push("silent")')
    );
  });

  it("the deposit chip is derived from a claim's POLARITY, not an else branch", () => {
    const tags = readCode("src/lib/vendor-tags.ts");
    expect(tags).toMatch(/claimsIn\(/);
    expect(tags).toMatch(/polarity === "denied"/);
    // The else that turned "no deposit ... passport" into a passport deposit.
    expect(tags).not.toMatch(/\/passport\|id card\|driver'\?s\? licen\[cs\]e\//);
  });

  it("the model is TOLD what is established, asked and owed", () => {
    // The move set already makes a repeated fact-question impossible; this stops
    // a legal move from carrying a redundant question inside its text.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/ALREADY ESTABLISHED/);
    expect(pass).toMatch(/ALREADY ASKED/);
    expect(pass).toMatch(/STILL OWED/);
    expect(pass).toMatch(/ledgerBlock \+/);
  });

  it("shop TERMS are not screened as a document demand", () => {
    const risk = readCode("src/lib/inbound-risk.ts");
    expect(risk).toMatch(/describesTerms\(text\)/);
    // A DEMAND NEEDS A VERB. Matching the NOUNS "copy"/"photo" near "passport"
    // flagged every Thai shop's written deposit terms ("Copy Passport + 3000
    // THB") as document harvesting. Only a transmission verb can express
    // "send me your documents", and no terms statement can contain one.
    expect(risk).toMatch(/const TRANSMIT =/);
    expect(risk).toMatch(/send\|sends\|sending\|share/);
    expect(risk).not.toMatch(/const SCAN =/);
  });
});
