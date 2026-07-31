import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readFileSync } from "fs";
import { join } from "path";
import { worthAnInterruption, classifyReply, MAX_PUSHES_PER_WINDOW } from "./significance";
import type { NotifyState } from "./significance";
import { classifyActs, isDepositOptionsList } from "../wa/dialogue-acts";
import { counterAlreadyMade } from "../negotiation/deposit-counter";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const state = (over: Partial<NotifyState> = {}): NotifyState => ({
  anyReplyYet: true,
  sentInWindow: 0,
  ...over,
});

// The owner's decision: HIGH-VALUE PLUS AGENT-BLOCKED. Two halves, and the
// engine had neither.
//
// `worthAnInterruption` was the right idea and 80% built, but `classifyReply`
// could only ever return price / plain-reply / first-reply - so `deal-ready`
// was dead code the day it was written, and terms never existed at all. And
// every push the app sent described PROGRESS, so the one state that genuinely
// needs a human (the link dropped, the cheapest shop withdrew) was the one
// state that produced silence.

describe("the classes that were unreachable", () => {
  it("REPRODUCTION: deal-ready could not be produced by any call path", () => {
    expect(classifyReply({ anyReplyYet: true, pricePerDay: 180, dealReady: true }).kind).toBe(
      "deal-ready"
    );
    // ...and it is not claimed without a price to be ready ABOUT.
    expect(classifyReply({ anyReplyYet: true, dealReady: true }).kind).not.toBe("deal-ready");
  });

  it("terms are their own class - the second question of every rental", () => {
    expect(classifyReply({ anyReplyYet: true, termsLanded: true }).kind).toBe("terms");
    expect(worthAnInterruption({ kind: "terms" }, state()).notify).toBe(true);
  });

  it("a price still outranks terms in the same message", () => {
    expect(
      classifyReply({ anyReplyYet: true, pricePerDay: 180, termsLanded: true }).kind
    ).toBe("price");
  });

  it("and the noise it was written to stop is still stopped", () => {
    expect(worthAnInterruption({ kind: "plain-reply" }, state()).notify).toBe(false);
  });
});

describe("this shop moved, and that is news even when it is not the best", () => {
  it("REPRODUCTION: Sky Light dropped 250 -> 200 while another sat at 180", () => {
    // Not the session best, so the old gate said nothing. But a shop coming
    // down is the only evidence the traveller has that pushing works, and the
    // moment to decide whether to push again.
    const v = worthAnInterruption(
      { kind: "price", pricePerDay: 200, currency: "THB" },
      state({ bestPricePerDay: 180, bestCurrency: "THB", vendorPreviousPricePerDay: 250 })
    );
    expect(v.notify).toBe(true);
    expect(v.reason).toMatch(/came down from 250/);
  });

  it("a shop that did NOT move is not news", () => {
    const v = worthAnInterruption(
      { kind: "price", pricePerDay: 250, currency: "THB" },
      state({ bestPricePerDay: 180, bestCurrency: "THB", vendorPreviousPricePerDay: 250 })
    );
    expect(v.notify).toBe(false);
  });

  it("a new session best is still a new session best", () => {
    expect(
      worthAnInterruption(
        { kind: "price", pricePerDay: 150, currency: "THB" },
        state({ bestPricePerDay: 180, bestCurrency: "THB" })
      ).notify
    ).toBe(true);
  });
});

describe("agent-blocked: the class every push in the app was missing", () => {
  it("it always gets through - it is a handover, not news", () => {
    const v = worthAnInterruption({ kind: "agent-blocked" }, state({ sentInWindow: 99 }));
    expect(v.notify).toBe(true);
  });

  it("...whereas ordinary good news still stops at the ceiling", () => {
    expect(
      worthAnInterruption(
        { kind: "price", pricePerDay: 100 },
        state({ sentInWindow: MAX_PUSHES_PER_WINDOW })
      ).notify
    ).toBe(false);
  });

  it("a dropped WhatsApp link fires it", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/kind: "agent-blocked" \}, await notifyState\(email\)/);
    expect(ingest).toMatch(/WhatsApp disconnected/);
    expect(ingest).toMatch(/tag: "wa:disconnected"/);
  });

  it("so does the SESSION-CHEAPEST shop withdrawing", () => {
    // A shop declining is ordinary. The cheapest one declining is the plan
    // falling over, and the agent has nothing left to do about it.
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/const wasBest =/);
    expect(live).toMatch(/Your best price just fell through/);
    expect(live).toMatch(/tag: `lost:\$\{input\.ctx\.vendorId \?\? "best"\}`/);
  });
});

describe("ONE DOOR - every push goes through the gate and spends the budget", () => {
  it("the risk push no longer bypasses both", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    const risk = loop.slice(loop.indexOf("Check this reply") - 900, loop.indexOf("Check this reply") + 600);
    expect(risk).toMatch(/worthAnInterruption\(\{ kind: "risk" \}/);
    expect(risk).toMatch(/markPushSent\(ctx\.sender!, `risk: \$\{gate\.reason\}`\)/);
  });

  it("neither does the takeover push", () => {
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/worthAnInterruption\(\{ kind: "takeover" \}/);
    expect(ingest).toMatch(/markPushSent\(email, `takeover: \$\{g\.reason\}`\)/);
  });

  it("and the reply push knows which SHOP it is about", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/notifyState\(ctx\.sender!, Date\.now\(\), ctx\.vendorId\)/);
    expect(readCode("src/lib/notify/state.ts")).toMatch(/vendorPreviousPricePerDay/);
  });
});

describe("a deposit menu is information, not a question", () => {
  // The verbatim 12:49 message. The shop's own deposit menu, pasted, rendered
  // in the first person by a machine translator - Thai has no obligatory
  // subject pronoun, so "can use passport" comes back as "Can I use my
  // passport". Interrogative in form, informational in intent.
  const FIELD =
    "Can I use my passport as a deposit? Is a single original driver's license acceptable? Or 4,000 baht in cash along with my national ID card?";

  it("REPRODUCTION: the agent no longer tries to answer the shop's own template", () => {
    expect(isDepositOptionsList(FIELD)).toBe(true);
    const acts = classifyActs({ text: FIELD });
    expect(acts.ask).toBe("none");
    expect(acts.shared).toContain("deposit");
  });

  it("...and the terms are EXTRACTED from it, so it earns a push", () => {
    const acts = classifyActs({ text: FIELD });
    expect(classifyReply({ anyReplyYet: true, termsLanded: acts.shared.includes("deposit") }).kind).toBe(
      "terms"
    );
  });

  it("a real deposit QUESTION is still a question", () => {
    // One demand is not a menu, and it may well be a genuine ask.
    const acts = classifyActs({ text: "Can you send a photo of your passport please?" });
    expect(acts.ask).not.toBe("none");
    expect(isDepositOptionsList("We need a 4000 baht deposit.")).toBe(false);
  });

  it("it is structural - enumerated alternatives, not a phrase list", () => {
    expect(isDepositOptionsList("Deposit: 1) passport 2) 5000 THB cash")).toBe(true);
    // Deposit mentioned, nothing enumerated: not a menu.
    expect(isDepositOptionsList("The deposit is your passport.")).toBe(false);
    // Enumerated, but nothing to do with a deposit.
    expect(isDepositOptionsList("Do you want the red one or the blue one?")).toBe(false);
  });
});

describe("...and our OWN counter is not mistaken for one", () => {
  it("the counter is recognised by its shape, not by a substring", () => {
    expect(
      counterAlreadyMade([
        "Sounds good! Can we do a cash deposit instead, with a photo of our passport?",
      ])
    ).toBe(true);
  });

  it("REPRODUCTION-GUARD: a shop's menu echoed back does NOT retire our counter", () => {
    // The old test was a bare /cash\s+deposit/ substring. Our counter is
    // first-person and interrogative; so is the machine-translated menu. If a
    // shop's echo were ever ingested as ours, we would silently lose the one
    // counter we are allowed to make.
    expect(
      counterAlreadyMade(["Or 4,000 baht in cash along with my national ID card?"])
    ).toBe(false);
    expect(counterAlreadyMade(["We take a cash deposit of 4000 baht."])).toBe(false);
  });
});
