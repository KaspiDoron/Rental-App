import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveConfirmation,
  askedVehicleQuestion,
  affirms,
  UNCONFIRMED,
  type VehicleConfirmationState,
} from "./confirmation";

// THE MANGKORN THREAD, VERBATIM (Ko Pha-ngan field test, 30 Jul). The
// message-level gate can never confirm any of these replies - none names a
// vehicle - and in the field that meant: CHECKING MODEL forever, a re-asked
// confirm question at 15:40, no offers row, BEST PRICE showing a dash over a
// live ฿180. The CONVERSATION proves what the messages alone cannot.

const DECLARED = {
  class: "scooter" as const,
  displacementCc: 125,
  transmission: "automatic" as const,
};

const RFQ =
  "good day! How much per day, best price? (looking for an automatic scooter (125cc) to rent for 6 days) Khop khun ka!";
const CONFIRM_Q = "Just to confirm, is the 180 THB/day price for a fully automatic 125cc scooter?";

describe("the Mangkorn transcript resolves without a human", () => {
  it("the first price answer to our spec'd request becomes ASSUMED", () => {
    const s = resolveConfirmation(null, {
      declared: DECLARED,
      inboundText: "6 days 180 per day",
      lastOutboundText: RFQ,
      messageStatus: "needs-confirmation",
      hasPrice: true,
    });
    expect(s.status).toBe("assumed");
    // The RFQ is a price question, not an identity question - it never counts
    // as the confirm ask, or the first reply would silently self-confirm.
    expect(s.askedAt).toBeUndefined();
  });

  it("the shop's answer to our confirm question CONFIRMS the thread", () => {
    const assumed: VehicleConfirmationState = {
      status: "assumed",
      evidence: "direct answer",
      at: new Date().toISOString(),
    };
    const s = resolveConfirmation(assumed, {
      declared: DECLARED,
      inboundText: "If you rent for 6 days, it will definitely cost 180 baht per day.",
      lastOutboundText: CONFIRM_Q,
      messageStatus: "needs-confirmation",
      hasPrice: true,
    });
    expect(s.status).toBe("confirmed");
    expect(s.askedAt).toBeTruthy(); // the ask-once fact is now durable
  });

  it("a plain 'yes' to the confirm question also confirms", () => {
    const s = resolveConfirmation(UNCONFIRMED, {
      declared: DECLARED,
      inboundText: "Yes ka",
      lastOutboundText: CONFIRM_Q,
      messageStatus: null,
      hasPrice: false,
    });
    expect(s.status).toBe("confirmed");
  });

  it("CONFIRMED NEVER REGRESSES on a vehicle-less price update (the 1100b case)", () => {
    const confirmed: VehicleConfirmationState = {
      status: "confirmed",
      evidence: "affirmed",
      at: new Date().toISOString(),
      askedAt: new Date().toISOString(),
    };
    const s = resolveConfirmation(confirmed, {
      declared: DECLARED,
      inboundText: "Honda click 125cc 1100b./6days and we need your passport for deposit please",
      lastOutboundText: "Thanks! Any chance you can do a bit better for 6 days?",
      messageStatus: "needs-confirmation",
      hasPrice: true,
    });
    expect(s.status).toBe("confirmed");
  });

  it("hard evidence in the message itself confirms directly (Bigman's 'Honda click 125cc')", () => {
    const s = resolveConfirmation(null, {
      declared: DECLARED,
      inboundText: "Honda click 125cc 1200b./6days and we need your passport for deposit please",
      lastOutboundText: RFQ,
      messageStatus: "confirmed",
      hasPrice: true,
    });
    expect(s.status).toBe("confirmed");
  });

  it("a POSITIVELY different vehicle never upgrades the thread", () => {
    const s = resolveConfirmation(UNCONFIRMED, {
      declared: DECLARED,
      inboundText: "we only have 150cc manual motorbike, 300 per day",
      lastOutboundText: CONFIRM_Q,
      messageStatus: "wrong-vehicle",
      hasPrice: true,
    });
    expect(s.status).toBe("unconfirmed");
  });
});

describe("the question detector separates a confirm ask from an RFQ", () => {
  it("recognizes the confirm-question family", () => {
    expect(askedVehicleQuestion(CONFIRM_Q, DECLARED)).toBe(true);
    expect(askedVehicleQuestion("Is the 125cc scooter you mentioned a fully automatic one?", DECLARED)).toBe(true);
  });
  it("an RFQ asking for a price is NOT a confirm ask", () => {
    expect(askedVehicleQuestion(RFQ, DECLARED)).toBe(false);
  });
  it("affirmations are recognized, chatter is not", () => {
    expect(affirms("yes, definitely")).toBe(true);
    expect(affirms("Please wait a moment")).toBe(false);
  });
});

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the thread fact is wired end to end (source pins)", () => {
  it("agent-loop resolves the state per turn and a confirmed thread upgrades the message", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/resolveConfirmation\(prevConf, \{/);
    expect(loop).toMatch(/extraction\.vehicleConfirmation = conf;/);
    // needs-confirmation no longer forces matchesSpec=false - that single line
    // starved offers, BEST PRICE, rivals and cards all at once in the field.
    expect(loop).not.toMatch(/matchesSpec = false; \/\/ unresolved is NOT a match/);
  });

  it("the state persists with the negotiation thread and never regresses there", () => {
    const state = readCode("src/lib/graph/state.ts");
    // W-15 pulled the never-regress branch out of this one call site into
    // `mergeVehicleConfirmation`, because the inbound path now persists the
    // fact too - the graph engine's write path was the only one, and that
    // engine effectively never runs. Both writers go through the same rule.
    expect(state).toMatch(/f\.vehicleConfirmation = mergeVehicleConfirmation\(/);
    expect(state).toMatch(/if \(prev\?\.status !== "confirmed" \|\| next\.status === "confirmed"\) return next;/);
    // ...and the fact is actually written on an ordinary turn, which is the
    // half that was missing. See confirmation-memory.test.ts.
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/saveVehicleConfirmation\(/);
  });

  it("/api/replies merges thread state over per-row derivation", () => {
    const replies = readCode("src/app/api/replies/route.ts");
    expect(replies).toMatch(/st\?\.vehicleConfirmation\?\.status/);
    // A per-row WRONG vehicle stays wrong even on a confirmed thread.
    expect(replies).toMatch(/rowGate\?\.status === "wrong-vehicle"/);
    // VERIFIED needs the vehicle established, not just the column pair.
    expect(replies).toMatch(/vehicleStatus === "confirmed"/);
  });

  it("SPTE asks ONCE: policy gates on vehicleAsked and the rail stops rewriting after the ask", () => {
    expect(readCode("src/lib/spte/policy.ts")).toMatch(/!v\.vehicleAsked/);
    const rails = readCode("src/lib/spte/rails.ts");
    expect(rails).toMatch(/vehicleAsked/);
    expect(rails).toMatch(/identityBlocks/);
  });

  it("the manual Confirm-the-model button is gone; the mismatch CTA stays", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).not.toMatch(/Confirm the model/);
    expect(card).toMatch(/Ask for the right vehicle/);
    // The badge WORDS moved into one vocabulary (lib/offer-badges) so the
    // label and the tooltip that explains it cannot drift apart. The state is
    // unchanged; only where the string lives is.
    const badges = readCode("src/lib/offer-badges.ts");
    expect(badges).toMatch(/label: "UNVERIFIED"/);
  });

  it("BEST PRICE shows the minimum immediately with the honest confidence label", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).toMatch(/offerConfidence\(cheapest\.offer\) === "unverified"/);
    expect(page).toMatch(/unverified - confirming/);
  });
});
