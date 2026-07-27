import { describe, it, expect } from "vitest";
import {
  claimsIn,
  claimsAcross,
  clausesOf,
  documentForm,
  latestClaim,
  settled,
  surrendersDocument,
} from "./claims";

const deposit = (text: string) =>
  claimsIn(text, "shop", 0).find((c) => c.subject === "deposit");
const handover = (text: string) =>
  claimsIn(text, "shop", 0).find((c) => c.subject === "handover");

// ---------------------------------------------------------------------------
// A requirement with two components has two components.
// ---------------------------------------------------------------------------

describe("details: a composite deposit keeps every component", () => {
  it("cash AND a passport copy is both, not whichever matched first", () => {
    // The bug this pins: only the first matching kind survived, so the passport
    // half of "3000 cash and a passport copy" was destroyed at parse time - in
    // the layer the tags, filters and risk screen all treat as ground truth.
    const c = deposit("Deposit is 3000 cash and a passport copy")!;
    expect(c.details).toEqual(["cash", "passport"]);
  });

  it("details are ordered as the shop said them, and `detail` is the first", () => {
    const c = deposit("Deposit: passport or 2,000 baht")!;
    expect(c.details).toEqual(["passport", "cash"]);
    expect(c.detail).toBe(c.details[0]);
  });

  it("a single-component deposit still reads exactly as it always did", () => {
    expect(deposit("Deposit 3000 baht cash")?.detail).toBe("cash");
    expect(deposit("We keep your passport as deposit")?.detail).toBe("passport");
    expect(deposit("Deposit 3000 baht cash")?.details).toEqual(["cash"]);
  });

  it("a subject with nothing named carries no details rather than a guess", () => {
    const c = deposit("There is a deposit")!;
    expect(c.details).toEqual([]);
    expect(c.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AND is a bill, OR is a choice.
// ---------------------------------------------------------------------------

describe("combinator: and never collapses into or", () => {
  it("'and' is a list of requirements", () => {
    expect(deposit("Deposit is 3000 cash and a passport copy")?.combinator).toBe("and");
    expect(deposit("Deposit: passport plus 2000 baht")?.combinator).toBe("and");
  });

  it("'or' is a choice", () => {
    expect(deposit("Deposit 3000 baht or passport")?.combinator).toBe("or");
    expect(deposit("you can leave passport or ID card at shop as deposit")?.combinator).toBe("or");
  });

  it("the two are DIFFERENT values for the same pair of components", () => {
    const and = deposit("Deposit: passport and 2000 baht")!;
    const or = deposit("Deposit: passport or 2000 baht")!;
    expect(and.details).toEqual(or.details);
    expect(and.combinator).not.toBe(or.combinator);
  });

  it("one component is 'single' - there is nothing to combine", () => {
    expect(deposit("Deposit 3000 baht cash")?.combinator).toBe("single");
  });

  it("two components with no connector read as a list, not a choice", () => {
    // Telling a traveller they may choose when they must supply both is the
    // error that costs them money at the counter, so juxtaposition is "and".
    expect(deposit("Deposit: passport copy, 3000 baht")?.combinator).toBe("and");
  });
});

// ---------------------------------------------------------------------------
// Keeping the passport and photographing it are not the same deal.
// ---------------------------------------------------------------------------

describe("form: the original surrendered vs a copy taken", () => {
  it("'we keep your passport' surrenders the document", () => {
    const c = deposit("We keep your passport as deposit")!;
    expect(documentForm(c)).toBe("original");
    expect(surrendersDocument(c)).toBe(true);
  });

  it("'we take a photo of your passport' does not", () => {
    const c = deposit("For the deposit we just take a photo of your passport at the shop")!;
    expect(documentForm(c)).toBe("copy");
    expect(surrendersDocument(c)).toBe(false);
  });

  it("reads the photocopy the counter actually says", () => {
    // \bcopy\b cannot match inside "photocopy" - both neighbours are word
    // characters - and "photocopy" is the standard counter word in the region.
    for (const phrase of [
      "deposit is a photocopy of your passport",
      "deposit: passport photocopy",
      "for the deposit we need a scan of the passport",
      "deposit is passport xerox",
    ]) {
      expect(documentForm(deposit(phrase)!)).toBe("copy");
    }
  });

  it("says nothing when the shop said nothing", () => {
    expect(documentForm(deposit("Deposit 3000 baht or passport")!)).toBeUndefined();
  });

  it("the form belongs to its own document, not to the clause", () => {
    const c = deposit("Deposit: we keep your passport and take a licence copy")!;
    const byKind = Object.fromEntries(c.parts.map((p) => [p.detail, p.form]));
    expect(byKind.passport).toBe("original");
    expect(byKind.licence).toBe("copy");
  });

  it("a form marker in the next segment stays there", () => {
    const c = deposit("Deposit: we keep your passport, send a copy of the licence")!;
    const byKind = Object.fromEntries(c.parts.map((p) => [p.detail, p.form]));
    expect(byKind.passport).toBe("original");
    expect(byKind.licence).toBe("copy");
    expect(surrendersDocument(c)).toBe(true);
  });

  it("money has no form", () => {
    const c = deposit("Deposit 3000 baht cash")!;
    expect(c.parts[0].form).toBeUndefined();
    expect(surrendersDocument(c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// When, and of whom - the axes that separate procedure from harvesting.
// ---------------------------------------------------------------------------

describe("timing and target", () => {
  it("counter procedure is at the handover", () => {
    for (const phrase of [
      "we take passport photo at shop",
      "You can bring passport copy when you come to shop",
      "no deposit needed sir, just your passport at pickup",
      "deposit is paid on arrival",
    ]) {
      expect(claimsIn(phrase, "shop", 0)[0].timing).toBe("at-handover");
    }
  });

  it("a demand before anything exists is up front", () => {
    for (const phrase of [
      "deposit must be paid first to reserve the bike",
      "we need the deposit in advance",
    ]) {
      expect(claimsIn(phrase, "shop", 0)[0].timing).toBe("up-front");
    }
  });

  it("unstated stays unstated - it is not guessed either way", () => {
    expect(deposit("Deposit 3000 baht")?.timing).toBe("unstated");
  });

  it("'we take / we keep' is the shop's own action", () => {
    expect(deposit("We keep your passport as deposit")?.target).toBe("shop");
    expect(handover("We deliver to your hotel")?.target).toBe("shop");
  });

  it("'bring / send / show' is something the traveller must do", () => {
    expect(handover("come to shop with passport copy")?.target).toBe("traveller");
    expect(handover("please bring it to the shop")?.target).toBe("traveller");
  });
});

// ---------------------------------------------------------------------------
// Told, or asked.
// ---------------------------------------------------------------------------

describe("force: a question is not an answer", () => {
  it("a shop question is an ASK, not a statement of terms", () => {
    expect(handover("Do you want delivery or pickup?")?.force).toBe("ask");
    expect(deposit("How much deposit can you leave?")?.force).toBe("ask");
  });

  it("a statement about the same subject is an ASSERT", () => {
    expect(handover("We deliver to your hotel")?.force).toBe("assert");
    expect(deposit("Deposit 3000 baht cash")?.force).toBe("assert");
  });

  it("an interrogative with no question mark still asks - chat drops them", () => {
    expect(handover("do you want us to deliver")?.force).toBe("ask");
  });

  it("a question SETTLES nothing", () => {
    expect(settled(claimsIn("Do you want delivery or pickup?", "shop", 0), "handover")).toBe(false);
    expect(settled(claimsIn("We deliver to your hotel", "shop", 0), "handover")).toBe(true);
  });

  it("a caller who classified the message properly can overrule the guess", () => {
    // "Any questions?" is rhetorical - the act layer knows that and this layer
    // never will, so it hands its verdict down rather than growing a second
    // classifier here.
    const asked = claimsIn("we deliver to your hotel", "shop", 0, { force: "ask" });
    expect(asked[0].force).toBe("ask");
    const told = claimsIn("do you want delivery?", "shop", 0, {
      force: (clause) => (/^do you want/i.test(clause) ? "assert" : undefined),
    });
    expect(told[0].force).toBe("assert");
    // A hint that declines to decide falls back to reading the clause.
    const fallback = claimsIn("do you want delivery?", "shop", 0, { force: () => undefined });
    expect(fallback[0].force).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// The things every later layer builds on.
// ---------------------------------------------------------------------------

describe("clauses are the unit, and everything is scoped to one", () => {
  it("the splitter keeps the terminator - '?' is the strongest force signal", () => {
    expect(clausesOf("Do you want delivery? Deposit is 3000")).toEqual([
      "Do you want delivery?",
      "Deposit is 3000",
    ]);
  });

  it("a claim carries which clause it came from", () => {
    const claims = claimsIn("Deposit 2000. We deliver to your hotel", "shop", 0);
    expect(claims.find((c) => c.subject === "deposit")?.clauseIndex).toBe(0);
    expect(claims.find((c) => c.subject === "handover")?.clauseIndex).toBe(1);
  });

  it("a question in one clause does not silence a statement in the next", () => {
    const claims = claimsIn("Do you want delivery? Deposit is 3000 baht cash", "shop", 0);
    expect(claims.find((c) => c.subject === "handover")?.force).toBe("ask");
    expect(claims.find((c) => c.subject === "deposit")?.force).toBe("assert");
  });

  it("is total on junk input", () => {
    expect(clausesOf("")).toEqual([]);
    expect(claimsIn("", "shop", 0)).toEqual([]);
    expect(claimsIn("...", "shop", 0)).toEqual([]);
    expect(claimsAcross([], "shop")).toEqual([]);
  });

  it("keeps the polarity fix it was written for", () => {
    const c = latestClaim(claimsIn("No deposit needed sir, just your passport at pickup", "shop", 0), "deposit");
    expect(c?.polarity).toBe("denied");
  });
});

// ---------------------------------------------------------------------------
// The article-free register these shops actually write in.
// ---------------------------------------------------------------------------

describe("handover parses without articles", () => {
  it("'come to shop' and 'at shop' are handover claims", () => {
    // Requiring "the"/"our" meant the most common phrasing in the region simply
    // produced no claim at all, so every layer asking "is this the shop
    // describing its counter procedure?" was told no.
    for (const phrase of [
      "come to shop with passport copy",
      "we take passport photo at shop",
      "you must show passport and we make copy in shop",
      "passport copy needed, you give at shop",
    ]) {
      expect(handover(phrase)?.polarity).toBe("affirmed");
      expect(handover(phrase)?.detail).toBe("pickup");
    }
  });

  it("still reads the article-ful version identically", () => {
    expect(handover("please come to the shop")?.detail).toBe("pickup");
    expect(handover("we can deliver it to your hotel")?.detail).toBe("delivery");
  });
});
