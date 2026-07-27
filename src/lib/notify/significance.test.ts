import { describe, it, expect } from "vitest";
import {
  MAX_PUSHES_PER_WINDOW,
  classifyReply,
  worthAnInterruption,
  type NotifyState,
} from "./significance";

const state = (over: Partial<NotifyState> = {}): NotifyState => ({
  anyReplyYet: false,
  sentInWindow: 0,
  ...over,
});

describe("a notification has to be paid for in information", () => {
  it("an auto-greeting from the fifth shop is not news", () => {
    // The report, exactly: a dozen shops answer "Thanks for messaging us, we
    // are open 9 to 6", and every one of them buzzed the traveller's phone.
    const v = worthAnInterruption({ kind: "plain-reply" }, state({ anyReplyYet: true }));
    expect(v.notify).toBe(false);
    expect(v.reason).toMatch(/nothing in it to act on/);
  });

  it("the FIRST shop to answer is worth knowing about, once", () => {
    expect(worthAnInterruption({ kind: "first-reply" }, state()).notify).toBe(true);
    expect(
      worthAnInterruption({ kind: "first-reply" }, state({ anyReplyYet: true })).notify
    ).toBe(false);
  });

  it("the first price always gets through", () => {
    const v = worthAnInterruption({ kind: "price", pricePerDay: 300, currency: "THB" }, state());
    expect(v.notify).toBe(true);
    expect(v.reason).toMatch(/first price/);
  });

  it("a BETTER price gets through; a worse one does not", () => {
    const s = state({ bestPricePerDay: 300, bestCurrency: "THB" });
    expect(worthAnInterruption({ kind: "price", pricePerDay: 250, currency: "THB" }, s).notify).toBe(
      true
    );
    expect(worthAnInterruption({ kind: "price", pricePerDay: 380, currency: "THB" }, s).notify).toBe(
      false
    );
    expect(worthAnInterruption({ kind: "price", pricePerDay: 300, currency: "THB" }, s).notify).toBe(
      false
    );
  });

  it("a cheaper NUMBER in another currency is not a cheaper price", () => {
    const s = state({ bestPricePerDay: 300, bestCurrency: "THB" });
    // 250 PHP against 300 THB is not a comparison - treat it as a first price
    // rather than silently calling it an improvement.
    const v = worthAnInterruption({ kind: "price", pricePerDay: 250, currency: "PHP" }, s);
    expect(v.notify).toBe(true);
    expect(v.reason).toMatch(/first price/);
  });

  it("a price event carrying no price is not a price", () => {
    expect(worthAnInterruption({ kind: "price" }, state()).notify).toBe(false);
  });

  it("a completed deal is always worth it", () => {
    expect(worthAnInterruption({ kind: "deal-ready" }, state()).notify).toBe(true);
  });

  it("a photo we could not read is not the traveller's problem to solve", () => {
    expect(worthAnInterruption({ kind: "media-problem" }, state()).notify).toBe(false);
  });
});

describe("the ceiling, and what is allowed through it", () => {
  it("good news stops at the budget", () => {
    const s = state({ sentInWindow: MAX_PUSHES_PER_WINDOW });
    expect(worthAnInterruption({ kind: "price", pricePerDay: 100 }, s).notify).toBe(false);
    expect(worthAnInterruption({ kind: "deal-ready" }, s).notify).toBe(false);
  });

  it("things only the traveller can decide are never budgeted away", () => {
    const s = state({ sentInWindow: MAX_PUSHES_PER_WINDOW * 10 });
    expect(worthAnInterruption({ kind: "risk" }, s).notify).toBe(true);
    expect(worthAnInterruption({ kind: "takeover" }, s).notify).toBe(true);
  });

  it("the budget is a handful, not a stream", () => {
    expect(MAX_PUSHES_PER_WINDOW).toBeLessThanOrEqual(5);
  });
});

describe("classifying a reply happens in one place", () => {
  it("a price is a price; anything else depends on whether the hunt is live", () => {
    expect(classifyReply({ pricePerDay: 250, currency: "THB", anyReplyYet: true }).kind).toBe(
      "price"
    );
    expect(classifyReply({ anyReplyYet: false }).kind).toBe("first-reply");
    expect(classifyReply({ anyReplyYet: true }).kind).toBe("plain-reply");
    expect(classifyReply({ pricePerDay: 0, anyReplyYet: true }).kind).toBe("plain-reply");
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

describe("the reply loop asks before it interrupts", () => {
  it("every reply push goes through the judgement", () => {
    const a = readCode("src/lib/agent-loop.ts");
    expect(a).toMatch(/worthAnInterruption\(event, state\)/);
    expect(a).toMatch(/if \(!verdict\.notify\) return;/);
    expect(a).toMatch(/markPushSent\(/);
  });

  it("a shop simply replying no longer buzzes on its own", () => {
    const a = readCode("src/lib/agent-loop.ts");
    expect(a).not.toMatch(/just replied - tap to open WheelDeal/);
  });

  it("unreadable media is an in-app event, not a lock-screen alert", () => {
    const i = readCode("src/lib/wa/ingest.ts");
    expect(i).not.toMatch(/A photo didn't come through/);
    expect(i).not.toMatch(/A shop sent a document/);
    // ...but it is still recorded where the traveller can see it.
    expect(i).toMatch(/media-fetch-failed/);
    expect(i).toMatch(/media-unreadable/);
  });

  it("takeover still reaches them - it is a handover, not news", () => {
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(/You've got the wheel/);
  });
});
