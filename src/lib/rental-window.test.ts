import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveWindow, withinWindow, clampRfqWindow, localDay, PLAN_DAYS_AHEAD } from "./rental-window";
import {
  signalsIn,
  assessIntegrity,
  liveSignals,
  requiresOwnerApproval,
  SIGNAL_TTL_MS,
  type IntegritySignal,
} from "./integrity/signals";

// 2026-07-27, 09:00 UTC.
const NOW = Date.parse("2026-07-27T09:00:00.000Z");

describe("one authority decides when a rental may start", () => {
  it("a free plan is same-day only", () => {
    expect(PLAN_DAYS_AHEAD.free).toBe(0);
    const d = resolveWindow({ plan: "free", requested: "2026-07-28", nowMs: NOW });
    expect(d.adjusted).toBe(true);
    expect(d.startDate).toBe("2026-07-27");
    expect(d.reason).toMatch(/free plan/i);
  });

  it("free CAN book today", () => {
    expect(withinWindow({ plan: "free", requested: "2026-07-27", nowMs: NOW })).toBe(true);
  });

  it("paid plans book ahead", () => {
    expect(withinWindow({ plan: "pro", requested: "2026-08-10", nowMs: NOW })).toBe(true);
    expect(withinWindow({ plan: "ultra", requested: "2026-12-01", nowMs: NOW })).toBe(true);
    // ...but not indefinitely.
    expect(withinWindow({ plan: "pro", requested: "2027-08-10", nowMs: NOW })).toBe(false);
  });

  it("a past date is moved to today for EVERY plan - a stale form is not an upsell", () => {
    for (const plan of ["free", "pro", "ultra"]) {
      const d = resolveWindow({ plan, requested: "2020-01-01", nowMs: NOW });
      expect(d.startDate).toBe("2026-07-27");
      expect(d.reason).toMatch(/passed/i);
    }
  });

  it("no requested date means today, and that is not an adjustment", () => {
    const d = resolveWindow({ plan: "free", nowMs: NOW });
    expect(d.startDate).toBe("2026-07-27");
    expect(d.adjusted).toBe(false);
  });

  it("the day is the TRAVELLER's local day, not the server's", () => {
    // 23:30 UTC is already tomorrow in Bangkok - a same-day rule that used UTC
    // would refuse a traveller their own today.
    const lateUtc = Date.parse("2026-07-27T23:30:00.000Z");
    expect(localDay(lateUtc, "Asia/Bangkok")).toBe("2026-07-28");
    expect(withinWindow({ plan: "free", requested: "2026-07-28", nowMs: lateUtc, timeZone: "Asia/Bangkok" })).toBe(true);
  });

  it("junk input never throws and never widens the window", () => {
    expect(resolveWindow({ plan: "free", requested: "not-a-date", nowMs: NOW }).startDate).toBe("2026-07-27");
    expect(resolveWindow({ plan: null, requested: "2026-08-01", nowMs: NOW }).adjusted).toBe(true);
  });
});

describe("the RFQ is clamped BEFORE twenty shops hear about it", () => {
  it("moves the start and keeps the trip length", () => {
    const { rfq, adjusted } = clampRfqWindow(
      { startDate: "2026-07-30", returnDate: "2026-08-03" },
      { plan: "free", nowMs: NOW }
    );
    expect(adjusted).toBe(true);
    expect(rfq.startDate).toBe("2026-07-27");
    expect(rfq.returnDate).toBe("2026-07-31"); // still four days
  });

  it("leaves a request with no date alone", () => {
    const { rfq, adjusted } = clampRfqWindow({}, { plan: "free", nowMs: NOW });
    expect(adjusted).toBe(false);
    expect(rfq.startDate).toBeUndefined();
  });
});

describe("integrity is graduated, and never bans on its own", () => {
  const sig = (kind: IntegritySignal["kind"], at = NOW): IntegritySignal => ({
    kind,
    at,
    evidence: "…",
  });

  it("ONE phrase is a nudge, not a six-hour block", () => {
    // The old rule: one regex hit and the traveller lost the product for the
    // rest of their day, with no warning and nobody to appeal to.
    const v = assessIntegrity([sig("future-pickup")], NOW, "free");
    expect(v.step).toBe("nudge");
    expect(v.pauseMinutes).toBeUndefined();
    expect(v.message).toMatch(/free plan/i);
  });

  it("a pattern climbs the ladder", () => {
    const three = [sig("future-pickup"), sig("future-pickup"), sig("future-pickup")];
    expect(assessIntegrity(three, NOW, "free").step).toBe("cooldown");
    const five = [...three, sig("contact-exchange")];
    expect(assessIntegrity(five, NOW, "free").step).toBe("limit");
  });

  it("even the top rung is a PROPOSAL a human approves", () => {
    const many = [
      sig("off-platform-invite"),
      sig("off-platform-invite"),
      sig("contact-exchange"),
      sig("future-pickup"),
    ];
    const v = assessIntegrity(many, NOW, "free");
    expect(v.step).toBe("propose-block");
    expect(requiresOwnerApproval(v.step)).toBe(true);
    expect(v.evidence.length).toBeGreaterThan(0); // the owner sees WHY
    expect(v.message).not.toMatch(/banned|blocked permanently/i);
  });

  it("no single signal can reach the top rung on its own", () => {
    expect(assessIntegrity([sig("off-platform-invite")], NOW, "free").step).not.toBe("propose-block");
  });

  it("signals DECAY - a bad day does not follow someone around", () => {
    const old = sig("future-pickup", NOW - SIGNAL_TTL_MS - 1);
    expect(liveSignals([old], NOW)).toHaveLength(0);
    expect(assessIntegrity([old, old, old], NOW, "free").step).toBe("clear");
  });

  it("a PAYING traveller arranging next Tuesday is using the product, not evading", () => {
    const three = [sig("future-pickup"), sig("future-pickup"), sig("future-pickup")];
    expect(assessIntegrity(three, NOW, "pro").step).toBe("clear");
    // ...but going off-platform still counts on any plan.
    expect(assessIntegrity([sig("off-platform-invite"), sig("contact-exchange")], NOW, "pro").step).not.toBe("clear");
  });

  it("reads the signal kinds it claims to, with the evidence attached", () => {
    const s = signalsIn("can I pick it up tomorrow? message me directly on +66 81 234 5678", NOW);
    expect(s.map((x) => x.kind).sort()).toEqual([
      "contact-exchange",
      "future-pickup",
      "off-platform-invite",
    ]);
    expect(s[0].evidence).toContain("tomorrow");
  });

  it("ordinary haggling raises nothing", () => {
    expect(signalsIn("Could you do 400 per day for the 4 days?", NOW)).toEqual([]);
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

describe("every surface that decides a date calls the same authority", () => {
  it("bookings enforces the plan window - it had NO check at all", () => {
    const b = readCode("src/app/api/bookings/route.ts");
    expect(b).toMatch(/resolveWindow\(/);
    expect(b).toMatch(/decision\.adjusted/);
  });

  it("the RFQ is clamped before the agents ask any shop", () => {
    expect(readCode("src/app/api/profile/route.ts")).toMatch(/clampRfqWindow/);
  });

  it("outreach uses the graduated ladder, not a one-strike cooldown", () => {
    const o = readCode("src/app/api/outreach/route.ts");
    expect(o).toMatch(/noteAndAssess/);
    expect(o).toMatch(/underReview/);
    // The old shape: one regex hit -> setCooldown(360).
    expect(o).not.toMatch(/setCooldown\(session\.email, "pickup-bypass", 360/);
  });

  it("a block proposal is queued for the owner WITH its evidence", () => {
    const s = readCode("src/lib/integrity/store.ts");
    // The event name is a shared constant now, so the producer and the owner's
    // queue can never drift apart (its value is pinned in adjudication.test).
    expect(s).toMatch(/kind: PROPOSAL_EVENT/);
    expect(s).toMatch(/evidence: verdict\.evidence/);
    expect(s).toMatch(/no action taken automatically/i);
    // Rides the existing soft, expiring, reasoned table - no migration.
    expect(s).toMatch(/user_cooldowns/);
  });
});
