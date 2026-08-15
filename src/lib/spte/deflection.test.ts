import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { legalMovesFor } from "./policy";
import { emptyDigest, mergeDigest } from "./digest";
import { fallbackArtifact } from "./pass";
import { MOVE_KINDS, moveGlossary } from "./moves";
import type { ThreadDigest, TurnArtifact, TurnContext, VerifiedExtraction } from "./types";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE BRUSH-OFF (owner report 5 #8).
//
//   shop: "You should try asking other shops; maybe they'll give you one."
//   us:   "Could you let me know your daily rate for the automatic 125cc
//          scooter?"
//
// Nothing in the system had a category for being sent away. Dialogue acts
// carry ASK kinds and SHARE kinds with no refusal member; the one
// terminal-refusal reader is DECLINED_RX, whose alternatives are "not
// interested", "good luck", "take it there" - none of which a polite brush-off
// contains, in any language. So with shopUnavailable=false, declined=false,
// wrongVehicle=false, no question asked, firmCount 0 and no price, that turn
// walked the whole ladder to its "no price yet" default - whose only legal
// moves ARE rate re-asks - and coerceToLegal forced one out the door.

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
    inbound: {
      text: partial.text ?? "You should try asking other shops; maybe they'll give you one.",
      verified: partial.verified,
    },
    legalMoves: [],
    guards: { maxRounds: 4 },
    event: "shop-message",
  };
}

/** The ask-once gate has already retired the price question (we asked in the
 *  opener), which is precisely the state that made the re-ask so absurd. */
const ASKED_PRICE = digest({
  ledger: { claims: [], known: [], outstanding: ["price"], owed: [] },
});

describe("W4.3 - a shop that sends us elsewhere is not a shop to re-ask", () => {
  it("REPRODUCTION: without the deflection verdict the ladder re-asks the rate", () => {
    // This is the failure, preserved: the SAME message with no comprehension
    // verdict on it still falls through to the no-price default. It is the
    // reading that changed, not the rest of the ladder.
    const legal = legalMovesFor(ctx({ verified: { found: false } }));
    expect(legal).toContain("clarify");
  });

  it("a deflecting shop gets ONE warm goodbye and nothing else", () => {
    const legal = legalMovesFor(ctx({ verified: { found: false, deflected: true }, digest: ASKED_PRICE }));
    expect(legal).toEqual(["graceful-close", "silent"]);
    // The whole point: no move in the set can ask this shop anything.
    expect(legal).not.toContain("clarify");
    expect(legal).not.toContain("momentum");
    expect(legal).not.toContain("bargain");
  });

  it("...and only one. A second event on a closed thread is silence", () => {
    const legal = legalMovesFor(
      ctx({
        verified: { found: false, deflected: true },
        digest: digest({ facts: ["closed - one goodbye sent"] }),
      })
    );
    expect(legal).toEqual(["silent"]);
  });

  it("a STOCK-OUT still outranks it - a shop with nothing is not a shop saying no", () => {
    // The precedence the ladder already had, now also enforced on the reading
    // (comprehension.ts refuses to call a stock-out a deflection). Belt and
    // braces: even a turn flagged both ways keeps the thread alive.
    const legal = legalMovesFor(
      ctx({ verified: { found: false, deflected: true, shopUnavailable: true } })
    );
    expect(legal).toContain("restock-probe");
    expect(legal).not.toContain("graceful-close");
  });

  it("the goodbye it sends carries no question at all", () => {
    const c = ctx({ verified: { found: false, deflected: true }, digest: ASKED_PRICE });
    c.legalMoves = legalMovesFor(c);
    const fb = fallbackArtifact(c);
    expect(fb.move).toBe("graceful-close");
    expect(fb.message).toBeTruthy();
    // A template with a question mark in it would rebuild the exact bug.
    expect(fb.message).not.toMatch(/\?/);
    expect(fb.message).not.toMatch(/price|rate|deposit/i);
  });

  it("...and a RAIL, not just a template, keeps a price out of it", () => {
    // The template cannot carry one, but the model composes the real message.
    // `graceful-close` is a goodbye by any other name, so it is held to the
    // same farewell-integrity guarantee: a goodbye that names a number or
    // agrees to one does not go out.
    const rails = readCode("src/lib/spte/rails.ts");
    const end = rails.indexOf('rule: "farewell-integrity"');
    expect(end).toBeGreaterThan(0);
    const guard = rails.slice(rails.lastIndexOf('artifact.move === "restock-probe"', end) - 400, end);
    expect(guard).toMatch(/artifact\.move === "graceful-close"/);
  });

  it("the model is TOLD what graceful-close means (the `close` lesson)", () => {
    const gloss = moveGlossary(["graceful-close"]);
    expect(gloss).toMatch(/thank them/i);
    expect(gloss).toMatch(/never ask/i);
    expect(MOVE_KINDS).toContain("graceful-close");
  });

  it("the digest records the brush-off, so hasClosed() can see it", () => {
    const artifact: TurnArtifact = {
      read: { intent: "" },
      think: "",
      move: "graceful-close",
      leverageUsed: [],
      digestPatch: [],
    };
    const d = mergeDigest(emptyDigest(), artifact, { found: false, deflected: true });
    expect(d.facts).toContain("shop pointed us elsewhere - not dealing");
    expect(d.facts).toContain("closed - one goodbye sent");
  });
});

describe("W4.3 - the verdict comes from a model, never from a phrase list", () => {
  const comp = readCode("src/lib/spte/comprehension.ts");
  const live = readCode("src/lib/spte/live.ts");

  it("the classifiers that had zero callers are wired into the live turn", () => {
    // `readAvailability` returns exactly the state the stock branch needs and
    // said so in its own schema; it had no callers at all. Same for
    // readDepositTerms. The new stance read joins them.
    expect(comp).toMatch(/readComprehension/);
    expect(comp).toMatch(/readAvailability/);
    expect(comp).toMatch(/readDepositTerms/);
    expect(live).toMatch(/const comp = await runComprehension\(/);
    expect(live).toMatch(/verified\.deflected = comp\.deflected/);
  });

  it("nothing in the deflection path matches words against the message", () => {
    // The doctrine, enforced: no regex literal may appear in the module that
    // decides whether a shop is refusing to deal.
    expect(comp).not.toMatch(/=\s*\/[^/\n]+\/[gimsuy]*\s*[;,)]/);
    expect(comp).not.toMatch(/\.test\(/);
  });

  it("they run on the ENGLISH GLOSS when the loop produced one", () => {
    expect(live).toMatch(/const gloss = \(input\.inboundEnglish \?\? ""\)\.trim\(\)/);
    expect(live).toMatch(/const text = gloss \|\| raw/);
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/inboundEnglish = english/);
    expect(loop).toMatch(/^\s*inboundEnglish,$/m);
  });

  it("an AI outage changes NOTHING - it degrades, it never guesses", () => {
    expect(comp).toMatch(/degraded/);
    // The stance read is what every terminal verdict is derived from, so a
    // missing one returns the empty comprehension rather than a default.
    expect(comp).toMatch(/if \(!c\) \{/);
    // ...and a hung provider cannot freeze the reply path.
    expect(comp).toMatch(/withCeiling\(/);
  });

  it("the SPTE path finally persists what the card reads", () => {
    // `negotiation_threads.fields.declined` / `.shopUnavailable` had exactly
    // ONE writer - applyExtractionToState, on the graph engine, which is the
    // FAILOVER. So on the engine that actually answers shops the card could
    // never say "this shop passed".
    expect(live).toMatch(/async function persistThreadOutcome/);
    expect(live).toMatch(/fields\.declined = true/);
    expect(live).toMatch(/fields\.shopUnavailable = verified\.shopUnavailable/);
    expect(live).toMatch(/await persistThreadOutcome\(/);
  });
});
