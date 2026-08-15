import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ONE fake provider for the whole comprehension phase. `semanticParse` sends
// the judgement's instructions as the system message, so the stub answers each
// of the three parallel reads by looking at what it was asked - which is also
// the cheapest possible proof that all three are actually being called.
const ai = vi.hoisted(() => ({
  answers: {} as Record<"stance" | "availability" | "deposit", unknown | null>,
  calls: [] as Array<{ system: string; premium: boolean }>,
  hang: false,
}));

vi.mock("../ai", () => ({
  chat: async () => null,
  extractJson: (t: string) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  },
  chatDetailed: async (
    msgs: Array<{ role: string; content: string }>,
    opts?: { tier?: string }
  ) => {
    const system = msgs[0]?.content ?? "";
    ai.calls.push({ system, premium: opts?.tier === "premium" });
    if (ai.hang) await new Promise((r) => setTimeout(r, 5_000));
    const which = system.includes("where does this shop stand")
      ? "stance"
      : system.includes("HAS the vehicle available")
        ? "availability"
        : "deposit";
    const answer = ai.answers[which];
    if (answer === null || answer === undefined) return { text: null, error: "no provider available" };
    return { text: JSON.stringify(answer), provider: "groq" };
  },
}));

import {
  ambiguousLedgerSubjects,
  isHighStakesComprehension,
  readTurnComprehension,
  STANCE_CONFIDENCE_FLOOR,
} from "./comprehension";

const stance = (over: Record<string, unknown> = {}) => ({
  stance: "engaged",
  stanceQuote: null,
  stanceReason: null,
  uncertain: [],
  confidence: 0.9,
  ...over,
});

beforeEach(() => {
  ai.answers = { stance: stance(), availability: null, deposit: null };
  ai.calls = [];
  ai.hang = false;
});

describe("the comprehension pass reads what a regex could not", () => {
  it("THE BRUSH-OFF: 'try asking other shops' is a deflection", async () => {
    ai.answers.stance = stance({
      stance: "deflecting",
      stanceQuote: "You should try asking other shops",
      confidence: 0.9,
    });
    const c = await readTurnComprehension({
      text: "You should try asking other shops; maybe they'll give you one.",
    });
    expect(c.deflected).toBe(true);
    expect(c.declined).toBe(false);
    expect(c.stanceQuote).toBe("You should try asking other shops");
    expect(c.degraded).toBe(false);
  });

  it("a stance the model is NOT sure of never ends a thread", async () => {
    ai.answers.stance = stance({ stance: "deflecting", confidence: STANCE_CONFIDENCE_FLOOR - 0.01 });
    const c = await readTurnComprehension({ text: "hmm, maybe try somewhere?" });
    // The verdict is kept for the trace and the prompt; nothing terminal fires.
    expect(c.stance).toBe("deflecting");
    expect(c.deflected).toBe(false);
  });

  it("A STOCK-OUT IS NOT A BRUSH-OFF, even when the model says both", async () => {
    // `readAvailability` says so in its own schema ("none" is a stock-out, "not
    // a refusal to deal") and had zero callers. This is the precedence the
    // ladder already applies, enforced one layer earlier on the READING.
    ai.answers.stance = stance({ stance: "deflecting", confidence: 0.95 });
    ai.answers.availability = { state: "none", backWhen: "tomorrow", freeMeansNoCost: null, confidence: 0.9 };
    const c = await readTurnComprehension({ text: "no bike today sorry, try the shop next door" });
    expect(c.deflected).toBe(false);
    expect(c.declined).toBe(false);
    expect(c.availability).toBe("none");
    expect(c.restockHint).toBe("tomorrow");
  });

  it("THE CANONICAL DEPOSIT: 'passport or money4000' comes back as a question", async () => {
    ai.answers.stance = stance({
      uncertain: [
        {
          subject: "deposit",
          reading: "they will hold the passport",
          question: "wait - you mean I can leave a passport OR 4,000 cash?",
          confidence: 0.5,
        },
      ],
    });
    const c = await readTurnComprehension({ text: "We have deposit passport or money4000" });
    expect(c.uncertain).toHaveLength(1);
    expect(c.uncertain[0].subject).toBe("deposit");
    expect(c.uncertain[0].question).toMatch(/\?$/);
    expect(ambiguousLedgerSubjects(c)).toEqual(["deposit"]);
  });

  it("...and the deposit classifier adds the doubt even if the stance read misses it", async () => {
    ai.answers.deposit = {
      stated: true,
      amount: 4000,
      currency: "THB",
      kind: "cash-or-document",
      document: "passport",
      quote: "deposit passport or money4000",
      confidence: 0.8,
    };
    const c = await readTurnComprehension({ text: "We have deposit passport or money4000" });
    expect(c.uncertain.map((u) => u.subject)).toContain("deposit");
    expect(c.uncertain[0].question).toMatch(/4000 THB cash OR the passport/i);
  });

  it("a doubt the model barely holds is not worth a message", async () => {
    ai.answers.stance = stance({
      uncertain: [{ subject: "price", reading: "300/day", question: "is that per day?", confidence: 0.1 }],
    });
    const c = await readTurnComprehension({ text: "300" });
    expect(c.uncertain).toEqual([]);
  });

  it("a plain message produces no doubt and no verdict to act on", async () => {
    const c = await readTurnComprehension({ text: "Click 125 is 300 baht per day." });
    expect(c.stance).toBe("engaged");
    expect(c.deflected).toBe(false);
    expect(c.uncertain).toEqual([]);
  });
});

describe("an AI outage degrades to today's behaviour, never to a guess", () => {
  it("no provider -> degraded, and nothing terminal", async () => {
    ai.answers = { stance: null, availability: null, deposit: null };
    const c = await readTurnComprehension({ text: "You should try asking other shops." });
    expect(c.degraded).toBe(true);
    expect(c.deflected).toBe(false);
    expect(c.declined).toBe(false);
    expect(c.uncertain).toEqual([]);
    expect(ambiguousLedgerSubjects(c)).toEqual([]);
  });

  it("a hung provider cannot freeze the reply path", async () => {
    ai.hang = true;
    const started = Date.now();
    const c = await readTurnComprehension({ text: "hello", budgetMs: 150 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(c.degraded).toBe(true);
    expect(c.deflected).toBe(false);
  });

  it("an empty message is not sent to a model at all", async () => {
    const c = await readTurnComprehension({ text: "   " });
    expect(ai.calls).toHaveLength(0);
    expect(c.degraded).toBe(false);
  });

  it("the availability read still lands when the stance read fails", async () => {
    // A stock-out is not terminal, so it is safe to carry on its own - and
    // losing it would put the thread back to haggling over a bike that is not
    // there.
    ai.answers = {
      stance: null,
      availability: { state: "none", backWhen: null, freeMeansNoCost: null, confidence: 0.9 },
      deposit: null,
    };
    const c = await readTurnComprehension({ text: "no bike now" });
    expect(c.degraded).toBe(true);
    expect(c.availability).toBe("none");
  });
});

describe("the strongest brain, only where it is worth paying for", () => {
  it("all three reads run in PARALLEL on one turn", async () => {
    await readTurnComprehension({ text: "300 baht, deposit passport" });
    expect(ai.calls).toHaveLength(3);
    const systems = ai.calls.map((c) => c.system).join("\n");
    expect(systems).toMatch(/where does this shop stand/);
    expect(systems).toMatch(/HAS the vehicle available/);
    expect(systems).toMatch(/what deposit or security/);
  });

  it("a high-stakes turn escalates to the premium chain; an ordinary one does not", async () => {
    await readTurnComprehension({ text: "hello", highStakes: true });
    expect(ai.calls.every((c) => c.premium)).toBe(true);
    ai.calls = [];
    await readTurnComprehension({ text: "hello" });
    expect(ai.calls.some((c) => c.premium)).toBe(false);
  });

  it("what counts as high stakes is a pure, reviewable rule", () => {
    // No price yet: a misread brush-off silently kills a shop that never quoted.
    expect(isHighStakesComprehension({ hasStandingPrice: false })).toBe(true);
    expect(isHighStakesComprehension({ hasStandingPrice: true, declined: true })).toBe(true);
    expect(isHighStakesComprehension({ hasStandingPrice: true, firm: true })).toBe(true);
    expect(isHighStakesComprehension({ hasStandingPrice: true, vehicleUnclear: true })).toBe(true);
    // The ordinary priced mid-negotiation turn - where the volume is.
    expect(isHighStakesComprehension({ hasStandingPrice: true })).toBe(false);
  });
});
