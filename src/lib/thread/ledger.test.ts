import { describe, it, expect, vi } from "vitest";

// vendor-tags is server-pinned and talks to Supabase for the VERIFIED half; the
// derivation under test here (one reply -> tags) is pure, so the pins are
// stubbed rather than the logic reimplemented.
vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  sbSelect: async () => [],
  sbInsert: async () => true,
}));

import { claimsIn, latestClaim, settled } from "./claims";
import { buildLedger, alreadyAsked, unaskedObligations } from "./ledger";
import { screenInbound, screenInboundDeterministic } from "../inbound-risk";
import { tagsFromExtraction } from "../vendor-tags";
import type { ExtractedOffer } from "../agents";

const NO_EXTRACTION = { found: false, matchesSpec: true } as ExtractedOffer;

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

describe("told and asked are different ledgers", () => {
  it("a shop QUESTION does not make its subject known", () => {
    // "Do you want delivery or pickup?" used to register as the shop having
    // TOLD us how handover works, so the engine stopped asking and the thread
    // could close on a fact nobody ever stated.
    const l = buildLedger({ inbound: ["250 baht per day", "Do you want delivery or pickup?"], outbound: [] });
    expect(l.known).not.toContain("handover");
    expect(l.shopAsked).toContain("handover");
    expect(l.owed).toContain("handover");
  });

  it("the same subject STATED does make it known", () => {
    const l = buildLedger({ inbound: ["250 baht per day", "We deliver to your hotel"], outbound: [] });
    expect(l.known).toContain("handover");
    expect(l.owed).not.toContain("handover");
    expect(l.shopAsked).not.toContain("handover");
  });

  it("a counter-question does not answer OUR question", () => {
    const l = buildLedger({
      inbound: ["Hello sir", "How many days do you want the bike for?"],
      outbound: ["Could you share your best price per day?"],
    });
    expect(alreadyAsked(l, "price")).toBe(true);
  });

  it("a caller that classified the burst properly can overrule the reading", () => {
    // The inbound act layer knows a rhetorical "any questions?" from a real
    // one; this is the seam it hands its verdict down through.
    const l = buildLedger({
      inbound: ["250 per day", "Do you want delivery or pickup?"],
      outbound: [],
      force: "assert",
    });
    expect(l.known).toContain("handover");
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

  it("the model is TOLD what is established, asked and owed", () => {
    // The move set already makes a repeated fact-question impossible; this stops
    // a legal move from carrying a redundant question inside its text.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/ALREADY ESTABLISHED/);
    expect(pass).toMatch(/ALREADY ASKED/);
    expect(pass).toMatch(/STILL OWED/);
    expect(pass).toMatch(/ledgerBlock \+/);
  });
});

// ---------------------------------------------------------------------------
// THE CHIP AND THE BANNER - the two surfaces that read the same sentence and
// used to disagree about it.
//
// These were assertions about the SOURCE of vendor-tags.ts and inbound-risk.ts:
// that one file contained `polarity === "denied"` and the other contained a
// literal regex. Source text is not behaviour - a correct redesign of either
// module fails a grep for the wrong reason, and the grep passes happily while
// the module misjudges every message. What we actually care about is the
// verdict, so that is what is asserted here.
// ---------------------------------------------------------------------------

describe("the deposit chip reads polarity, not the word 'passport'", () => {
  const tags = (reply: string) => tagsFromExtraction(NO_EXTRACTION, reply);

  it("the friendliest terms in the thread are NOT a passport deposit", () => {
    // The `else` this pins: no literal "no deposit" -> any "passport" became a
    // passport deposit, so the best terms on offer were badged as the worst.
    expect(tags(NO_DEPOSIT)).toContain("no-deposit");
    expect(tags(NO_DEPOSIT)).not.toContain("passport-deposit");
  });

  it("a real passport deposit still earns the chip", () => {
    expect(tags("We keep your passport as deposit")).toContain("passport-deposit");
  });

  it("a COMPOSITE deposit earns both chips, not whichever matched first", () => {
    // "Cash deposit" used to mean "you may pay instead of handing over your
    // passport" to a traveller filtering on it - and a shop wanting both was
    // shown under exactly that filter.
    const t = tags("Deposit is 3000 baht cash and a copy of your passport");
    expect(t).toContain("cash-deposit");
    expect(t).toContain("passport-deposit");
  });

  it("a shop QUESTION about the deposit is not a badge", () => {
    expect(tags("How much deposit can you leave?")).not.toContain("cash-deposit");
    expect(tags("How much deposit can you leave?")).not.toContain("passport-deposit");
  });
});

describe("the safety screen reads TERMS, not tokens", () => {
  // The register these shops actually write in: articles dropped, "passport
  // copy" as a bare noun phrase. Every one of these is a shop stating its
  // standard counter procedure, and a red scam banner on it teaches the
  // traveller to ignore the banner that matters.
  const TERMS = [
    "come to shop with passport copy",
    "we take passport photo at shop",
    "deposit 3000 baht or passport",
    "no deposit just passport at pickup",
    "You can bring passport copy when you come to shop",
    "Sir we take passport photo at shop when you rent",
    "passport copy needed, you give at shop",
    "Deposit 3000 baht cash when you pick up",
  ];

  it("standard counter terms are never HIGH risk", () => {
    for (const text of TERMS) {
      expect([text, screenInboundDeterministic(text).risk]).toEqual([text, "none"]);
    }
  });

  it("the async screen agrees with the deterministic one, with no LLM", () => {
    return Promise.all(
      TERMS.map(async (text) => {
        const r = await screenInbound(text, { llmAllowed: false });
        expect([text, r.risk]).toEqual([text, "none"]);
      })
    );
  });

  it("a genuine document demand is still HIGH", () => {
    for (const text of [
      "send me your passport photo now before I reserve",
      "forward a scan of your passport and ID card first",
      "Ok but first send photo of your passport to confirm booking",
    ]) {
      expect([text, screenInboundDeterministic(text).risk]).toEqual([text, "high"]);
    }
  });

  it("the reason names what the shop asked for, so the banner can quote it", () => {
    const r = screenInboundDeterministic("send me your passport photo now before I reserve");
    expect(r.reasons.join(" ")).toMatch(/passport/i);
  });
});
