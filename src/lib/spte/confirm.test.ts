import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { confirmSubjectFor, confirmableSubjects, legalMovesFor } from "./policy";
import { emptyDigest, mergeDigest } from "./digest";
import { fallbackArtifact } from "./pass";
import { moveGlossary } from "./moves";
import { buildLedger, subjectState } from "../thread/ledger";
import type { ThreadDigest, TurnArtifact, TurnContext, Uncertainty, VerifiedExtraction } from "./types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE CONFIRM-QUESTION DOCTRINE (owner report 5 #9, the owner's words):
//
//   "if the ai agents not sure about something - they should ask the shop
//    'wait, you mean that I can deposit a passport or cash 4000?' then wait for
//    the shop answer. If they are not positive about something (anything) they
//    should ask the shop, but in a way of a question."
//
// The move vocabulary is CLOSED and the only fact-confirmation move in it was
// `confirm-vehicle`; `clarify` is defined to the model as price-only. The
// extractor has emitted a `confidence` field and a `clarifyMessage` the whole
// time and the live SPTE engine read NEITHER. And `depositKnown` latched on the
// bare word "passport" anywhere in any inbound message, so the canonical case -
//
//   shop: "We have deposit passport or money4000"
//
// - settled the deposit subject forever on whichever of the two readings the
// extractor happened to take. There was no shape in the system for "they told
// us, and we are not sure we understood".

const DEPOSIT_DOUBT: Uncertainty = {
  subject: "deposit",
  reading: "they want the passport held",
  question: "wait - you mean I can leave a passport OR 4,000 cash?",
  confidence: 0.5,
};

const digest = (over: Partial<ThreadDigest> = {}): ThreadDigest => ({ ...emptyDigest(), ...over });

function ctx(partial: {
  verified: VerifiedExtraction;
  digest?: ThreadDigest;
  text?: string;
}): TurnContext {
  return {
    session: {
      sessionId: "s1",
      rfq: {
        vehicleClass: "scooter",
        engineSizeCc: 125,
        transmission: "automatic",
        durationDays: 4,
        accessories: [],
        fulfillment: "any",
        vendorMessage: "",
      },
      currency: "THB",
      benchmark: null,
      lowest: null,
      rivals: [],
    },
    thread: { threadKey: "u:66", vendorId: "v1", shop: "Shop A", digest: partial.digest ?? digest() },
    tail: [],
    inbound: { text: partial.text ?? "We have deposit passport or money4000", verified: partial.verified },
    legalMoves: [],
    guards: { maxRounds: 4, floorPerDay: 150 },
    event: "shop-message",
  };
}

describe("W4.4 - when the agent is not sure, it asks", () => {
  it("THE CANONICAL CASE: an ambiguous deposit makes `confirm` legal", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 300, uncertain: [DEPOSIT_DOUBT] },
        digest: digest({ quotedPricePerDay: 300 }),
      })
    );
    expect(legal).toContain("confirm");
    // ...and it outranks every price move: haggling a number while the terms
    // are a guess is how a traveller ends up handing over a passport.
    expect(legal.indexOf("confirm")).toBeLessThan(legal.indexOf("bargain"));
  });

  it("...and the question it sends is the shop's own ambiguity, put back", () => {
    const c = ctx({
      verified: { found: true, pricePerDay: 300, uncertain: [DEPOSIT_DOUBT] },
      digest: digest({ quotedPricePerDay: 300 }),
    });
    c.legalMoves = legalMovesFor(c);
    const fb = fallbackArtifact(c);
    expect(fb.move).toBe("confirm");
    expect(fb.message).toBe(DEPOSIT_DOUBT.question);
    // It is a QUESTION, which is the entire doctrine.
    expect(fb.message).toMatch(/\?/);
  });

  it("a plain message is never interrogated - no doubt, no confirm", () => {
    const legal = legalMovesFor(
      ctx({ verified: { found: true, pricePerDay: 300 }, digest: digest({ quotedPricePerDay: 300 }) })
    );
    expect(legal).not.toContain("confirm");
  });

  it("EXACTLY ONCE per subject - a spent confirm never comes back", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: true, pricePerDay: 300, uncertain: [DEPOSIT_DOUBT] },
        digest: digest({ quotedPricePerDay: 300, confirmAsked: ["deposit"] }),
      })
    );
    expect(legal).not.toContain("confirm");
  });

  it("the LEAST understood fact gets the thread's one question", () => {
    const c = ctx({
      verified: {
        found: true,
        pricePerDay: 300,
        uncertain: [
          { subject: "price", reading: "300 a day", question: "is 300 per day?", confidence: 0.8 },
          DEPOSIT_DOUBT,
        ],
      },
      digest: digest({ quotedPricePerDay: 300 }),
    });
    expect(confirmableSubjects(c)).toHaveLength(2);
    expect(confirmSubjectFor(c)?.subject).toBe("deposit");
  });

  it("a shop that already said no is never asked to clarify anything", () => {
    const shut: VerifiedExtraction[] = [
      { found: false, declined: true },
      { found: false, deflected: true },
      { found: false, shopUnavailable: true },
    ];
    for (const v of shut) {
      const legal = legalMovesFor(ctx({ verified: { ...v, uncertain: [DEPOSIT_DOUBT] } }));
      expect(legal).not.toContain("confirm");
    }
  });

  it("a question the SHOP asked is still answered first", () => {
    // Our doubt rides along with the answer; it never talks over them.
    const legal = legalMovesFor(
      ctx({ verified: { found: false, askedQuestion: true, uncertain: [DEPOSIT_DOUBT] } })
    );
    expect(legal[0]).toBe("answer");
    expect(legal).toContain("confirm");
  });

  it("the model is told what `confirm` means, in its own terms", () => {
    const gloss = moveGlossary(["confirm"]);
    expect(gloss).toMatch(/not sure/i);
    expect(gloss).toMatch(/question/i);
    expect(gloss).toMatch(/wait/i);
  });
});

describe("W4.4 - depositKnown stops latching on a reading nobody trusts", () => {
  it("the ledger gains a THIRD state: asked / answered / ambiguous", () => {
    const plain = buildLedger({
      inbound: ["Deposit is 3000 baht cash."],
      outbound: ["What's your deposit?"],
    });
    expect(subjectState(plain, "deposit")).toBe("answered");

    const unsure = buildLedger({
      inbound: ["We have deposit passport or money4000"],
      outbound: ["What's your deposit?"],
      ambiguous: ["deposit"],
    });
    // The SAME shop turn, read as ambiguous, is no longer an answer...
    expect(subjectState(unsure, "deposit")).toBe("ambiguous");
    expect(unsure.known).not.toContain("deposit");
    // ...and the thread still owes the traveller a deposit it can act on.
    expect(unsure.owed).toContain("deposit");
  });

  it("an unasked subject and an asked-but-unanswered one still read correctly", () => {
    const asked = buildLedger({ inbound: ["Hello"], outbound: ["What's your deposit?"] });
    expect(subjectState(asked, "deposit")).toBe("asked");
    expect(subjectState(asked, "handover")).toBe("unasked");
  });

  it("the live digest suppresses BOTH sources of depositKnown when ambiguous", () => {
    // `facts.depositKnown` is a regex that fires on the bare word "passport";
    // the ledger's typed claim fires too. Suppressing only one would leave the
    // deposit permanently "known" on the strength of the other.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/depositKnown:\s*!ambiguous\.includes\("deposit"\) &&/);
    expect(live).toMatch(/buildLedger\(\{ inbound, outbound, currentInbound: curInbound, ambiguous \}\)/);
  });
});

describe("W4.4 - the doubt is a model judgement, and it is remembered", () => {
  it("the confirm ask is recorded on the DURABLE digest", () => {
    const artifact: TurnArtifact = {
      read: { intent: "" },
      think: "",
      move: "confirm",
      confirmSubject: "deposit",
      message: DEPOSIT_DOUBT.question,
      leverageUsed: [],
      digestPatch: [],
    };
    const d = mergeDigest(emptyDigest(), artifact, { found: false, uncertain: [DEPOSIT_DOUBT] });
    expect(d.confirmAsked).toEqual(["deposit"]);
    expect(d.awaitingConfirmation?.subject).toBe("deposit");
    expect(d.awaitingConfirmation?.question).toBe(DEPOSIT_DOUBT.question);
  });

  it("...and cleared the moment the fact reads cleanly again", () => {
    const prev = emptyDigest();
    prev.awaitingConfirmation = { subject: "deposit", question: DEPOSIT_DOUBT.question };
    const artifact: TurnArtifact = {
      read: { intent: "" },
      think: "",
      move: "bargain",
      leverageUsed: [],
      digestPatch: [],
    };
    // The shop answered plainly -> nothing is uncertain -> the card stops
    // claiming we are double-checking something.
    const d = mergeDigest(prev, artifact, { found: true, pricePerDay: 280 });
    expect(d.awaitingConfirmation).toBeNull();
    // ...but it is HELD while the fact is still unsettled.
    const held = mergeDigest(prev, artifact, { found: false, uncertain: [DEPOSIT_DOUBT] });
    expect(held.awaitingConfirmation?.subject).toBe("deposit");
  });

  it("the subject is decided by the policy, never by the model", () => {
    // The model picks the MOVE from a closed vocabulary; which fact is
    // unsettled was already determined by what the comprehension pass could
    // not read. A model naming its own subject could re-ask a spent one.
    const orch = readCode("src/lib/spte/orchestrator.ts");
    expect(orch).toMatch(/artifact\.confirmSubject = confirmSubjectFor\(ctx\)\?\.subject/);
  });

  it("a deposit stated as a CHOICE is ambiguous by construction", () => {
    // Belt and braces on the canonical case: even if the stance model does not
    // flag it, `readDepositTerms` returning "cash-or-document" adds the doubt -
    // both readings latch depositKnown and only one of them is right.
    const comp = readCode("src/lib/spte/comprehension.ts");
    expect(comp).toMatch(/dep\.kind === "cash-or-document"/);
    expect(comp).toMatch(/subject: "deposit"/);
  });

  it("it is surfaced on the card, not just in the logs", () => {
    const route = readCode("src/app/api/replies/route.ts");
    expect(route).toMatch(/confirming: st\?\.awaitingConfirmation\?\.subject \?\? null/);
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/vendor\.confirming/);
    expect(card).toMatch(/Double-checking something with the shop before we trust it\./);
    const cat = readCode("src/lib/i18n-catalog.ts");
    expect(cat).toMatch(/Double-checking something with the shop before we trust it\./);
  });
});
