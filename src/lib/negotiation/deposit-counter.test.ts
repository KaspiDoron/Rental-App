import { describe, it, expect } from "vitest";
import {
  passportOnlyDeposit,
  counterAlreadyMade,
  composePassportCounter,
} from "./deposit-counter";
import { buildLedger } from "../thread/ledger";

const ledgerOf = (shopSaid: string[], weSaid: string[] = []) =>
  buildLedger({ inbound: shopSaid, outbound: weSaid });

// The field test, verbatim in shape: a shop states its deposit terms, and the
// traveller would rather not hand over their original passport. A human asks
// once, politely, and often gets a yes. The agent never asked at all.
describe("when a passport counter is due", () => {
  it("fires on ORIGINAL-passport-only terms", () => {
    expect(passportOnlyDeposit(ledgerOf(["For rent you leave original passport for deposit"]))).toBe(
      true
    );
    expect(passportOnlyDeposit(ledgerOf(["Deposit is passport"]))).toBe(true);
  });

  it("never fires when a CASH route is already on the table", () => {
    // "passport OR 3000 baht" already contains the answer we would ask for -
    // asking anyway wastes the thread's one cheap question.
    expect(
      passportOnlyDeposit(ledgerOf(["Deposit: original passport or 3000 baht cash"]))
    ).toBe(false);
    expect(passportOnlyDeposit(ledgerOf(["Deposit 3000 baht cash on pickup"]))).toBe(false);
  });

  it("never fires for a COPY - that costs the traveller nothing", () => {
    expect(passportOnlyDeposit(ledgerOf(["Just a copy of your passport for the deposit"]))).toBe(
      false
    );
  });

  it("never fires before the shop has said anything about a deposit", () => {
    expect(passportOnlyDeposit(ledgerOf(["125cc is 250 per day"]))).toBe(false);
    expect(passportOnlyDeposit(undefined)).toBe(false);
  });
});

describe("it is asked ONCE, and a decline is accepted", () => {
  it("our own prior cash-deposit ask retires the counter forever", () => {
    expect(counterAlreadyMade(["Could we do a cash deposit instead?"])).toBe(true);
    expect(counterAlreadyMade(["Can you do 200 per day?", undefined, null])).toBe(false);
  });

  it("the wording is a preference, never a refusal or a safety lecture", () => {
    for (const seed of ["thread-a", "thread-b", "thread-c", "thread-d"]) {
      const msg = composePassportCounter(seed);
      expect(msg).toMatch(/cash deposit/i);
      expect(msg).toMatch(/photo/i);
      // Never an accusation, never a threat to walk away.
      expect(msg).not.toMatch(/scam|illegal|refuse|not allowed|never/i);
    }
  });

  it("wording is SEEDED, not random - a golden replay stays byte-stable", () => {
    expect(composePassportCounter("thread-a")).toBe(composePassportCounter("thread-a"));
    const variants = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => composePassportCounter(s))
    );
    expect(variants.size).toBeGreaterThan(1); // ...and shops do not all get one script
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

describe("the strategy is actually reachable in the engine", () => {
  it("the policy makes ONE extra deposit-probe legal when the counter is due", () => {
    const policy = readCode("src/lib/spte/policy.ts");
    expect(policy).toMatch(/passportCounterDue\(ctx\)/);
    expect(policy).toMatch(/passportOnlyDeposit/);
    expect(policy).toMatch(/counterAlreadyMade/);
  });

  it("both the template and the prompt carry the strategy", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/composePassportCounter\(ctx\.thread\.threadKey\)/);
    expect(pass).toMatch(/ultra-polite counter/);
  });

  it("the card states the truth: a flag is a heads-up, not a block", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).not.toMatch(/Nothing was sent - review before you act/);
    expect(card).toMatch(/heads-up, not a block/);
    expect(card).toMatch(/setDismissedRisk/);
  });

  it("a delivery drop has its OWN kind - it never wears the risk styling", () => {
    expect(readCode("src/app/api/activity/route.ts")).toMatch(/kind: "drop"/);
    expect(readCode("src/components/activity/ActivityFeed.tsx")).toMatch(
      /it\.kind === "drop"/
    );
  });
});
