import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyActs, describeActs, isAsking } from "./dialogue-acts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE LIVE INCIDENT. A shop sent its price board, its opening hours and its
// deposit terms. The agent replied "Good question! Let's sort the main thing
// first - what's your best price per day?" - thanking the shop for a question
// nobody asked, and asking for a price the shop had just sent.

describe("a question mark is not a question", () => {
  it("a price line with a trailing '?' is sharing facts, not asking", () => {
    const acts = classifyActs({ text: "Click-125cc is 250 baht per day for 8 days 🙏?", pricePerDay: 250 });
    expect(acts.ask).toBe("none");
    expect(acts.shared).toContain("price");
    expect(isAsking(acts)).toBe(false);
  });

  it("a real question is still recognised, and named", () => {
    expect(classifyActs({ text: "which model would you like ?" }).ask).toBe("vehicle-choice");
    expect(classifyActs({ text: "Where are you staying?" }).ask).toBe("location");
    expect(classifyActs({ text: "Do you have an international license?" }).ask).toBe("license");
    expect(classifyActs({ text: "Can you send a photo of your licence?" }).ask).toBe(
      "license-photo"
    );
    expect(classifyActs({ text: "What dates do you need it?" }).ask).toBe("dates");
  });

  it("an automated greeting is not a turn waiting on us", () => {
    // Answering a form letter's rhetorical questions one by one is exactly how
    // the agent read as a bot talking to a bot.
    const acts = classifyActs({
      text: "Hello! 😃 (this is an automatic message) Kindly let us know all this info and we will message you back in a few minutes. How many days rental? Which model? What dates?",
    });
    expect(acts.autoReply).toBe(true);
    expect(acts.ask).toBe("none");
  });
});

describe("what the shop VOLUNTEERED is recorded, not just what it asked", () => {
  it("the incident turn reads as sharing, with nothing asked", () => {
    const acts = classifyActs({
      text: "Deposits for motorbikes (2 Options) 1) Or Original Passport 2) Or Copy Passport + 3000 THB. Open 9:00 AM - 10:00 PM",
      hadImage: true,
      imageKind: "price_sheet",
      pricePerDay: 250,
    });
    expect(acts.ask).toBe("none");
    expect(acts.shared).toEqual(expect.arrayContaining(["price", "price-board", "deposit", "hours"]));
  });

  it("describes the turn in words a prompt can use", () => {
    const line = describeActs(classifyActs({ text: "deposit is 3000 baht", pricePerDay: 250 }));
    expect(line).toMatch(/shared/);
    expect(line).toMatch(/asked nothing/);
  });

  it("more than one tier counts as options", () => {
    expect(classifyActs({ text: "we have two", optionCount: 2 }).shared).toContain("options");
  });
});

describe("the engine is wired to the acts, not to punctuation", () => {
  it("the live mapper computes acts and derives askedQuestion FROM them", () => {
    const l = readCode("src/lib/spte/live.ts");
    expect(l).toMatch(/const acts = classifyActs\(/);
    expect(l).toMatch(/askedQuestion: acts\.ask !== "none"/);
    // The old shape: `askedQuestion: text ? shopAskedQuestion(text) : false`,
    // where shopAskedQuestion is `/\?/.test(text) || ...`.
    expect(l).not.toMatch(/askedQuestion: text \? shopAskedQuestion\(text\) : false/);
  });

  it("the canned opener is gone and the answer template acknowledges reality", () => {
    const p = readCode("src/lib/spte/pass.ts");
    expect(p).not.toMatch(/Good question!/);
    expect(p).toMatch(/const shared = v\.acts\?\.shared \?\? \[\]/);
    // Never re-ask for a price we can already see.
    expect(p).toMatch(/const known = v\.pricePerDay \?\? v\.sheetPricePerDay/);
  });

  it("the prompt states WHAT was asked, and says so when nothing was", () => {
    const p = readCode("src/lib/spte/pass.ts");
    expect(p).toMatch(/The shop did NOT ask you anything/);
    expect(p).toMatch(/do not open with filler/);
  });

  it("what the shop SENT finally reaches the model", () => {
    // imageSummary was computed on every turn and never put in the prompt, so
    // a shop that answered with four price boards looked like one that said
    // nothing at all.
    const p = readCode("src/lib/spte/pass.ts");
    expect(p).toMatch(/FROM THEIR PHOTO we read/);
    expect(p).toMatch(/SHOP'S TURN: \$\{describeActs\(/);
  });
});
