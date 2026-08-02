import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkCommitment, stripCommitment } from "./spte/rails";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE ENGINE THAT COULD BOOK A BIKE NOBODY AGREED TO.
//
// The traveller's decision has exactly one expression in this system: the Lock
// This Deal button, which produces the `closing-message` move. Anything else
// that books, reserves, accepts or announces we are on our way is the app
// deciding for them - and a shop that holds a bike on that promise is a real
// person losing a real rental when the traveller picks a cheaper shop.
//
// SPTE enforced that. The GRAPH engine did not, and could not: the rail lived
// inside runPostRails, which needs a full TurnContext - session snapshot,
// rivals, guards, a verified extraction - that the graph engine never builds.
// And the graph engine is the live FALLBACK on every path plus the SOLE engine
// on both user-action routes. So on exactly the paths where a traveller has
// just tapped something, nothing stopped the promise.
//
// The rail needs two inputs: the text, and the move that produced it. It is a
// standalone function now, called by both engines, so there is one definition
// of "what counts as committing" rather than a second copy free to drift.

describe("the rail itself", () => {
  it("closing-message is the ONE move allowed to commit", () => {
    // It exists only after the traveller pressed Lock This Deal.
    expect(checkCommitment("I'll take it, please reserve it for me", "closing-message")).toBeNull();
  });

  it("any other move committing is rejected, with the phrase quoted", () => {
    const r = checkCommitment("Great - I'll take it then.", "bargain");
    expect(r).not.toBeNull();
    expect(r!.rule).toBe("commitment");
    expect(r!.detail).toContain("bargain");
    expect(r!.detail).toContain("I'll take it");
    expect(r!.detail).toContain("only Lock This Deal");
  });
});

describe("the phrasings a real traveller's agent would produce", () => {
  // Each COMMITS. Every one of these was reachable before the widening.
  const COMMITS = [
    "I'll take it.",
    "We'll take that one.",
    "Book it for tomorrow please.",
    "Please reserve it for me.",
    "It's a deal.",
    "I accept.",
    "Let's do it.",
    "I'm on my way.",
    "I'll come pick it up at 5.",
    "I'll go with it.",
    "We'll go for the 150.",
    "Count me in.",
    "Sign me up.",
    "I'm in.",
    "We're in.",
    "Confirming the booking now.",
    "Confirmed the reservation.",
    "I'll pay on arrival.",
    "We'll pay the deposit today.",
    "See you tomorrow at the shop.",
    "Meet you at 10 then.",
  ];

  for (const text of COMMITS) {
    it(`rejects: "${text}"`, () => {
      expect(checkCommitment(text, "bargain"), text).not.toBeNull();
    });
  }
});

describe("...and the near-misses that must STILL get through", () => {
  // This is the half that makes widening safe. The regex carries a comment
  // saying it is narrow ON PURPOSE - "sounds good" while haggling is register,
  // not a booking - and every phrase added above has a neighbour here that a
  // careless pattern would have swallowed. Information gathering is untouched
  // by design: asking what deposit they take is how the traveller learns
  // enough to decide.
  const FINE = [
    "Sounds good, what about the deposit?",
    "That works - what documents do you need?",
    "Great, and does that include a helmet?",
    "OK. Can you do 250 for 5 days?",
    "Perfect, is it available from the 4th?",
    "Understood. Do you deliver to the hotel?",
    "Good to know - I'll think about it and come back to you.",
    "Thanks! I'm comparing a couple of shops today.",
    "Can I pay by card?",
    "Would you take 240 if I book for a week?",
    "Do you accept a passport copy instead?",
    "I agree that 300 is a fair list price, but can you move on it?",
    "See what you can do on the price and let me know.",
  ];

  for (const text of FINE) {
    it(`allows: "${text}"`, () => {
      expect(checkCommitment(text, "bargain"), text).toBeNull();
    });
  }
});

describe("a rejection loses the promise, not the whole turn", () => {
  it("strips only the committing sentence", () => {
    const out = stripCommitment("That works for us. I'll take it. What deposit do you need?");
    expect(out).not.toMatch(/I'll take it/);
    // The question the shop is waiting on survives - dropping the whole draft
    // and replacing it with a template is how the agent started repeating
    // itself in the field.
    expect(out).toContain("What deposit do you need?");
  });

  it("...and what is left is clean by the same rail", () => {
    const out = stripCommitment("Great. I'm on my way. Which street are you on?");
    expect(checkCommitment(out, "bargain")).toBeNull();
    expect(out).toContain("Which street are you on?");
  });

  it("an all-commitment draft strips to nothing, and the caller must not send it", () => {
    expect(stripCommitment("I'll take it.")).toBe("");
  });
});

describe("both engines are bound to it", () => {
  it("SPTE runs it inside runPostRails", () => {
    const rails = readCode("src/lib/spte/rails.ts");
    expect(rails).toMatch(/const commit = checkCommitment\(text, artifact\.move\);/);
    expect(rails).toMatch(/if \(commit\) return \{ ok: false, rejected: commit \};/);
  });

  it("REPRODUCTION: the graph engine runs it too, keyed on the node KIND", () => {
    // Keyed on kind and never on id: an owner-edited graph spec can rename a
    // node's id, and keying on id would let the renamed node commit.
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/checkCommitment\(text, args\.nodeKind\)/);
    expect(engine).toMatch(/text = stripCommitment\(text\);/);
    // An empty result must not be sent as a blank message.
    expect(engine).toMatch(/commitment guard: nothing left to send/);
  });

  it("there is exactly ONE definition of what commits", () => {
    // A second copy in the other engine is free to drift, which is how this
    // became a per-engine property in the first place.
    const rails = readFileSync(join(process.cwd(), "src/lib/spte/rails.ts"), "utf8");
    expect(rails.match(/const COMMIT_RX =/g)?.length).toBe(1);
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).not.toMatch(/COMMIT_RX/);
  });
});
