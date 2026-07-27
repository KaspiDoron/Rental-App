import { describe, it, expect } from "vitest";
import {
  BLOCK_KIND,
  BLOCK_PRESETS,
  DECISION_EVENT,
  MAX_BLOCK_MINUTES,
  PROPOSAL_EVENT,
  caseStateFor,
  decodeDecision,
  encodeDecision,
  isBlockMinutes,
  latestDecisionFor,
  latestSignalAt,
  needsDecision,
  partitionCases,
  type IntegrityDecision,
  type ProposalCase,
} from "./adjudication";
import { LADDER, assessIntegrity, type IntegritySignal } from "./signals";

const NOW = Date.parse("2026-07-27T10:00:00Z");

const decision = (over: Partial<IntegrityDecision> = {}): IntegrityDecision => ({
  email: "t@example.com",
  action: "reject",
  minutes: 0,
  restrictAccount: false,
  note: "looked fine",
  at: NOW,
  by: "owner@example.com",
  ...over,
});

const kase = (over: Partial<ProposalCase> = {}): ProposalCase => ({
  email: "t@example.com",
  plan: "free",
  step: "propose-block",
  score: 7,
  evidence: ["message me directly"],
  signalCount: 3,
  latestSignalAt: NOW,
  state: "pending",
  decision: null,
  restrictedMinutes: 0,
  accountBlocked: false,
  ...over,
});

describe("a decision only settles the evidence it was made on", () => {
  it("no decision means the owner has not looked yet", () => {
    expect(caseStateFor(NOW, null)).toBe("pending");
  });

  it("a decision made AFTER the newest signal closes the case", () => {
    expect(caseStateFor(NOW, decision({ at: NOW + 1000, action: "reject" }))).toBe("rejected");
    expect(caseStateFor(NOW, decision({ at: NOW + 1000, action: "approve" }))).toBe("approved");
    expect(caseStateFor(NOW, decision({ at: NOW + 1000, action: "lift" }))).toBe("lifted");
  });

  it("NEW evidence after a rejection re-opens the case, with nothing to remember it", () => {
    // This is the whole reason there is no "re-flag" branch anywhere: a
    // rejection settles what the owner SAW, never the traveller's future.
    const rejected = decision({ at: NOW, action: "reject" });
    expect(caseStateFor(NOW + 60_000, rejected)).toBe("pending");
  });

  it("an approval does not immunise either - fresh signals ask again", () => {
    const approved = decision({ at: NOW, action: "approve", minutes: 1440 });
    expect(caseStateFor(NOW + 60_000, approved)).toBe("pending");
  });

  it("the newest decision wins, and only for the right traveller", () => {
    const ds = [
      decision({ email: "a@x.com", at: NOW - 5000, action: "approve" }),
      decision({ email: "a@x.com", at: NOW, action: "lift" }),
      decision({ email: "b@x.com", at: NOW + 9999, action: "approve" }),
    ];
    expect(latestDecisionFor(ds, "a@x.com")?.action).toBe("lift");
    expect(latestDecisionFor(ds, "A@X.com")?.action).toBe("lift"); // case-insensitive
    expect(latestDecisionFor(ds, "c@x.com")).toBeNull();
  });
});

describe("only the top rung ever asks the owner for anything", () => {
  it("a traveller mid-ladder is context, never a decision", () => {
    expect(needsDecision(kase({ step: "cooldown" }))).toBe(false);
    expect(needsDecision(kase({ step: "limit" }))).toBe(false);
    expect(needsDecision(kase({ step: "propose-block" }))).toBe(true);
  });

  it("a decided top-rung case leaves the ask list", () => {
    expect(needsDecision(kase({ state: "approved", decision: decision() }))).toBe(false);
  });

  it("partitions into ask / audit / context, and nothing lands in two of them", () => {
    const cases = [
      kase({ email: "ask@x.com", score: 7 }),
      kase({ email: "worse@x.com", score: 12 }),
      kase({
        email: "done@x.com",
        state: "approved",
        decision: decision({ email: "done@x.com", action: "approve", at: NOW + 1 }),
      }),
      kase({ email: "watch@x.com", step: "cooldown", score: 3 }),
    ];
    const { proposals, decided, watch } = partitionCases(cases);
    expect(proposals.map((c) => c.email)).toEqual(["worse@x.com", "ask@x.com"]); // worst first
    expect(decided.map((c) => c.email)).toEqual(["done@x.com"]);
    expect(watch.map((c) => c.email)).toEqual(["watch@x.com"]);
    expect(proposals.length + decided.length + watch.length).toBe(cases.length);
  });

  it("a cleared traveller is not context either", () => {
    const { watch } = partitionCases([kase({ step: "clear", score: 0 })]);
    expect(watch).toHaveLength(0);
  });
});

describe("the decision record survives a round trip, and rejects junk", () => {
  it("carries action, duration, escalation, reason and author", () => {
    const detail = encodeDecision({
      action: "approve",
      minutes: 1440,
      restrictAccount: true,
      note: "three off-platform invites in an hour",
      by: "owner@example.com",
    });
    const back = decodeDecision({
      user_email: "T@Example.com",
      detail,
      created_at: "2026-07-27T10:00:00Z",
    });
    expect(back).toEqual({
      email: "t@example.com",
      action: "approve",
      minutes: 1440,
      restrictAccount: true,
      note: "three off-platform invites in an hour",
      at: NOW,
      by: "owner@example.com",
    });
  });

  it("an unreadable or unrelated row is not a decision", () => {
    expect(decodeDecision({ user_email: "t@x.com", detail: "not json", created_at: "" })).toBeNull();
    expect(decodeDecision({ user_email: "", detail: "{}", created_at: "" })).toBeNull();
    expect(
      decodeDecision({ user_email: "t@x.com", detail: '{"action":"delete"}', created_at: "" })
    ).toBeNull();
  });

  it("a rejection never smuggles a duration through", () => {
    const d = decodeDecision({
      user_email: "t@x.com",
      detail: encodeDecision({
        action: "reject",
        minutes: 0,
        restrictAccount: false,
        note: "",
        by: "o@x.com",
      }),
      created_at: "2026-07-27T10:00:00Z",
    });
    expect(d?.minutes).toBe(0);
    expect(d?.restrictAccount).toBe(false);
  });
});

describe("every restriction this system can impose has an end", () => {
  it("even the longest preset is a DATE, so 'Lift now' is always possible", () => {
    expect(BLOCK_PRESETS.length).toBeGreaterThan(1);
    for (const p of BLOCK_PRESETS) {
      expect(p.minutes).toBeGreaterThan(0);
      expect(p.minutes).toBeLessThanOrEqual(MAX_BLOCK_MINUTES);
    }
    expect(BLOCK_PRESETS[0].minutes).toBeLessThanOrEqual(1440); // the gentlest is a day
  });

  it("a duration has to be a real, bounded number of minutes", () => {
    expect(isBlockMinutes(1440)).toBe(true);
    expect(isBlockMinutes(0)).toBe(false);
    expect(isBlockMinutes(-5)).toBe(false);
    expect(isBlockMinutes("soon")).toBe(false);
    expect(isBlockMinutes(MAX_BLOCK_MINUTES + 1)).toBe(false);
  });

  it("the block cooldown does NOT reuse the signal row's key", () => {
    // `kind=integrity` holds the signal blob, whose `until` is always now+48h
    // and whose `reason` is JSON - reading it as a cooldown would report a
    // permanent block for anyone who ever tripped a single signal.
    expect(BLOCK_KIND).not.toBe("integrity");
  });
});

describe("the ladder's own table decides which rungs restrict", () => {
  it("the top rung pauses like the one below it - a proposal is not a punishment", () => {
    const top = LADDER.find((r) => r.step === "propose-block");
    const limit = LADDER.find((r) => r.step === "limit");
    expect(top?.pauseMinutes).toBe(limit?.pauseMinutes);
  });

  it("a nudge carries no pause, so callers gating on pauseMinutes let it through", () => {
    expect(LADDER.find((r) => r.step === "nudge")?.pauseMinutes).toBeUndefined();
  });

  it("reaching the top rung pauses for hours, not for the 48h the evidence lives", () => {
    const sig = (kind: IntegritySignal["kind"]): IntegritySignal => ({
      kind,
      at: NOW,
      evidence: "…",
    });
    const v = assessIntegrity(
      [sig("off-platform-invite"), sig("off-platform-invite"), sig("contact-exchange")],
      NOW,
      "free"
    );
    expect(v.step).toBe("propose-block");
    expect(v.pauseMinutes).toBeLessThanOrEqual(240);
  });
});

describe("latestSignalAt", () => {
  it("is the newest, ignores garbage timestamps, and is 0 when empty", () => {
    expect(latestSignalAt([{ at: 5 }, { at: 99 }, { at: 7 }])).toBe(99);
    expect(latestSignalAt([{ at: Number.NaN }])).toBe(0);
    expect(latestSignalAt([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. The queue only closes the loop if the pieces agree on the names,
// and if the two authorities stay separate.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the proposal reaches a human, and only a human restricts", () => {
  it("the event names are exactly what the producer and the queue both use", () => {
    expect(PROPOSAL_EVENT).toBe("integrity-review");
    expect(DECISION_EVENT).toBe("integrity-decision");
  });

  it("the queue is derived from the SIGNALS, not from the fire-and-forget event", () => {
    // A queue built on `agent_events` would silently lose a person every time
    // that insert failed - and losing one means either an unseen bypass or a
    // traveller stuck behind a pause with no case for the owner to clear.
    const q = readCode("src/lib/integrity/queue.ts");
    expect(q).toMatch(/user_cooldowns/);
    expect(q).toMatch(/assessIntegrity\(/);
    expect(q).not.toMatch(/kind=eq\.\$\{PROPOSAL_EVENT\}/);
  });

  it("outreach blocks on the ladder's PAUSE, never on the step name", () => {
    const o = readCode("src/app/api/outreach/route.ts");
    expect(o).toMatch(/verdict\.pauseMinutes/);
    // The old shape: reaching the top rung refused every send for as long as
    // the evidence stayed live, with no owner ever in the loop.
    expect(o).not.toMatch(/verdict\.step !== "clear" && verdict\.step !== "nudge"/);
  });

  it("a longer restriction can ONLY come from an owner-approved cooldown", () => {
    const o = readCode("src/app/api/outreach/route.ts");
    expect(o).toMatch(/cooldownLeft\(session\.email, BLOCK_KIND\)/);
  });

  it("the gentlest rung actually reaches the traveller", () => {
    const o = readCode("src/app/api/outreach/route.ts");
    expect(o).toMatch(/notice = verdict\.message/);
    expect(o).toMatch(/\n\s*notice,\n/);
  });

  it("a refused booking is evidence, not something the server forgets", () => {
    const b = readCode("src/app/api/bookings/route.ts");
    expect(b).toMatch(/recordSignal\(/);
    expect(b).toMatch(/kind: "future-pickup"/);
  });

  it("the approval screen is owner-only, like every other Ops route", () => {
    const r = readCode("src/app/api/admin/ops/integrity/route.ts");
    expect(r.match(/requireOwner\(\)/g)?.length).toBe(2); // GET and POST
    expect(r).toMatch(/Owner only\./);
    // A restriction nobody can explain later is one nobody should be able to set.
    expect(r).toMatch(/note\.length < 3/);
    expect(r).toMatch(/isBlockMinutes\(body\.minutes\)/);
  });

  it("the owner cannot restrict the owner", () => {
    const r = readCode("src/app/api/admin/ops/integrity/route.ts");
    expect(r).toMatch(/session\.email\.toLowerCase\(\)/);
  });

  it("the panel is mounted in the Ops shell", () => {
    const c = readCode("src/components/ops/OpsCenter.tsx").replace(/\s+/g, " ");
    expect(c).toMatch(/tab === "integrity" && <IntegrityPanel \/>/);
    expect(c).toMatch(/\["integrity", "🛡️ Block approvals"\]/);
  });

  it("a lift really releases - the account restriction that already exists is reused", () => {
    const q = readCode("src/lib/integrity/queue.ts");
    expect(q).toMatch(/clearCooldown\(email, BLOCK_KIND\)/);
    expect(q).toMatch(/setUserStatus\(email, "active"\)/);
    expect(q).toMatch(/setUserStatus\(email, "blocked"\)/);
  });

  it("the one-strike regex is gone from the cooldown lib", () => {
    const c = readCode("src/lib/cooldown.ts");
    expect(c).not.toMatch(/export function requestsFuturePickup/);
    expect(c).toMatch(/export async function clearCooldown/);
  });
});
