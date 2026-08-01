import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { INDEMNITY_CLAUSES, TERMS_SECTIONS, OPERATOR_NAME } from "./legal";

// SIX NAMED RISKS, EACH POINTABLE-AT.
//
// The general releases were already broad, and breadth is the problem: a clause
// covering "any and all claims" tells a traveller nothing about what can
// actually go wrong to them, and tells a court nothing about what they were
// told. These six are the failure modes this product really produces.
//
// The anchors are load-bearing. This suite exists so a future edit cannot
// quietly drop one while leaving the section looking complete.

const REQUIRED = [
  "misdirected-messages",
  "whatsapp-bans",
  "ai-errors",
  "vehicle-and-road",
  "deposits-and-documents",
  "payments-and-currency",
] as const;

describe("all six clauses are present, by anchor", () => {
  it("every required anchor exists exactly once", () => {
    const anchors = INDEMNITY_CLAUSES.map((c) => c.anchor);
    for (const a of REQUIRED) {
      expect(anchors.filter((x) => x === a).length).toBe(1);
    }
    expect(INDEMNITY_CLAUSES.length).toBe(REQUIRED.length);
  });

  it("each one is numbered, titled, summarised and written", () => {
    for (const c of INDEMNITY_CLAUSES) {
      expect(c.n).toMatch(/^\d+$/);
      expect(c.title.length).toBeGreaterThan(10);
      // The summary is what the first-touch modal shows: one readable line.
      expect(c.summary.length).toBeGreaterThan(20);
      expect(c.summary.length).toBeLessThan(160);
      expect(c.body.length).toBeGreaterThan(200);
    }
  });
});

describe("each clause actually names its scenario", () => {
  const bodyOf = (anchor: string) =>
    INDEMNITY_CLAUSES.find((c) => c.anchor === anchor)!.body.toLowerCase();

  it("(a) misdirected and unauthorised automated messages", () => {
    const b = bodyOf("misdirected-messages");
    expect(b).toMatch(/wrong|reassigned|private individual/);
    expect(b).toMatch(/misdirected/);
    expect(b).toMatch(/did not personally compose/);
  });

  it("(b) WhatsApp bans - the traveller's number AND the shop's", () => {
    const b = bodyOf("whatsapp-bans");
    expect(b).toMatch(/permanently ban/);
    // The half the old terms missed entirely: a SHOP can be flagged too.
    expect(b).toMatch(/business you message|business whose number/);
  });

  it("(c) AI pricing errors, false availability, unkeepable promises", () => {
    const b = bodyOf("ai-errors");
    expect(b).toMatch(/price that was never offered|wrong/);
    expect(b).toMatch(/available when it is not/);
    expect(b).toMatch(/commitment/);
  });

  it("(d) defects, accidents, insurance, helmets, fines", () => {
    const b = bodyOf("vehicle-and-road");
    expect(b).toMatch(/brakes|tyres|roadworthiness/);
    expect(b).toMatch(/helmet/);
    expect(b).toMatch(/insurance/);
    expect(b).toMatch(/fine/);
    expect(b).toMatch(/licence/);
  });

  it("(e) deposits, held passports, damage-claim extortion", () => {
    const b = bodyOf("deposits-and-documents");
    expect(b).toMatch(/passport/);
    expect(b).toMatch(/withheld to force payment/);
    expect(b).toMatch(/pre-existing damage/);
  });

  it("(f) payment gateway failure and currency conversion", () => {
    const b = bodyOf("payments-and-currency");
    expect(b).toMatch(/duplicate charge|chargeback/);
    expect(b).toMatch(/estimates/);
    expect(b).toMatch(/exchange-rate/);
  });
});

describe("they reach the real Terms, from ONE list", () => {
  it("every clause is rendered as a numbered section", () => {
    for (const c of INDEMNITY_CLAUSES) {
      const section = TERMS_SECTIONS.find((s) => s.n === c.n);
      expect(section, `section ${c.n} missing`).toBeTruthy();
      expect(section!.title).toBe(c.title);
      expect(section!.body).toBe(c.body);
    }
  });

  it("the section numbers stay unique and ordered after the splice", () => {
    const ns = TERMS_SECTIONS.map((s) => Number(s.n));
    expect(new Set(ns).size).toBe(ns.length);
    for (let i = 1; i < ns.length; i++) expect(ns[i]).toBeGreaterThan(ns[i - 1]);
  });

  it("the survival clause is still last, so the indemnities survive", () => {
    const last = TERMS_SECTIONS[TERMS_SECTIONS.length - 1];
    expect(last.title).toMatch(/survival/i);
    expect(last.body).toMatch(/indemnities/);
  });

  it("the operator is named the same way throughout - no orphan entity", () => {
    for (const c of INDEMNITY_CLAUSES) {
      if (c.body.includes("Operator") || c.body.includes(OPERATOR_NAME)) {
        expect(c.body).toContain(OPERATOR_NAME);
      }
    }
  });
});
