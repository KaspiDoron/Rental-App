import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("../runtime-config", () => ({
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbInsertClaim: async () => "won",
  getConfig: async () => undefined,
  setConfig: async () => ({ ok: true, persistent: false }),
  supabaseConfigured: () => true,
}));

import { getPolicies } from "../wa-guard";
import { PLAN_CAPACITY, effectiveNewContactCap } from "./capacity";
import { LIMIT_DEFAULTS } from "../usage";

// THE DOC PIN (owner report 3, 3.4 #11). The "as shipped" section of
// PRODUCTION-READINESS.md is the owner's operating reference for the anti-ban
// engine, and it had drifted from the code on FIVE numbers at once (60 sends
// where the lanes carry 280, a 40/day cap where the ceiling is 220, 50-120s
// gaps where the real spacing is 12-28s, pro 15 where the plan sells 20, a
// 45%-floor warm-up that had become a no-op). A reference that is wrong is
// worse than none - the owner tunes real dials against it. So the doc is now
// GENERATED-BY-HAND but VERIFIED-BY-MACHINE: every number below is derived
// from the same constants the runtime reads, and the doc must contain it.

const doc = readFileSync(join(process.cwd(), "PRODUCTION-READINESS.md"), "utf8")
  // Markdown hard-wraps prose, so phrases are matched whitespace-normalised.
  .replace(/\s+/g, " ");

describe("PRODUCTION-READINESS 'as shipped' numbers match the live constants", () => {
  it("names its own pin, so a future editor knows the numbers are enforced", () => {
    expect(doc).toContain("readiness-numbers.test.ts");
  });

  it("send lanes", () => {
    expect(doc).toContain(
      `cold introductions ${LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_HOUR}/hour and ${LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_DAY}/day`
    );
    expect(doc).toContain(
      `replies ${LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_HOUR}/hour and ${LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_DAY}/day`
    );
  });

  it("pacing, ceiling, hours and pause come from getPolicies() defaults", async () => {
    const p = await getPolicies();
    expect(doc).toContain(`base ${p.base_hour_cap}/hour growing to ${p.max_hour_cap}/hour`);
    // NOT "hard" any more: owner report 8 wave D put the all-lanes daily cap
    // under the warm-up ramp, so `day_cap` is what a WARM number reaches, not
    // what every number gets on day 0. The doc must state the number AND say
    // it ramps, or the word "hard" is the lie.
    expect(doc).toContain(`${p.day_cap}/day ceiling`);
    expect(doc).toContain("WARM-UP RAMPED");
    expect(doc).not.toContain(`${p.day_cap}/day hard ceiling`);
    expect(doc).toContain(`±${p.daily_cap_jitter_pct}% jitter`);
    expect(doc).toContain(`${p.min_gap_seconds}-${p.min_gap_seconds + p.gap_jitter_seconds}s jittered gaps`);
    expect(doc).toContain(`~${p.reply_gap_seconds}s per engaged shop`);
    expect(doc).toContain(
      `business hours 0${p.business_hour_start}-${p.business_hour_end}`
    );
    expect(doc).toContain(`risk score ${p.risk_pause_threshold} for ${p.risk_pause_minutes} min`);
    expect(doc).toContain(`over ${p.warmup_days} days`);
  });

  it("plan windows and the hourly floor come from PLAN_CAPACITY", () => {
    const { free, pro, ultra } = PLAN_CAPACITY;
    expect(doc).toContain(
      `free ${free.newContacts}/${free.windowHours}h, pro ${pro.newContacts}/${pro.windowHours}h, ultra ${ultra.newContacts}/${ultra.windowHours}h`
    );
    expect(doc).toContain(`free ${free.hourCap}/h, pro ${pro.hourCap}/h, ultra ${ultra.hourCap}/h`);
  });

  it("the day-0 ramp numbers are the ones effectiveNewContactCap actually produces", async () => {
    const p = await getPolicies();
    const day0 = (plan: string) => effectiveNewContactCap(plan, 0, p.warmup_days);
    expect(doc).toContain(`ultra ${day0("ultra")}, pro ${day0("pro")}, free ${day0("free")}`);
  });

  it("CONTAINING the right number is not enough - the wrong one must be ABSENT", () => {
    // Owner report 8 found PRODUCTION-READINESS.md stating the plan capacities
    // twice, 53 lines apart, with different numbers. This suite passed the
    // whole time, because every assertion here is `toContain`: a second,
    // contradictory sentence elsewhere in the file satisfies it. A reader
    // hitting the stale line first has no way to know which one is live.
    //
    // So the superseded values are pinned ABSENT. Each entry is a string that
    // was true once and is not any more.
    const dead = [
      "pro 15/4h",              // pro is 20/4h
      "ultra 40/3h",            // ultra is 24/3h
      "18/h headroom",          // ultra is 24/h
      "ramp floor is 45%",      // the floor is 50%
      "15 searches",            // 5 for the beta
      "120 AI calls",           // 300
      "default 40 linked",      // the per-host cap is 25
      "roughly **40 users**",   // 25
      "10min x attempts",       // recipient backoff is min(attempts*4,20) min
      "Batch size: 5 per",      // 24 reply + 48 general candidates
      "at most windowHours away, never tomorrow", // Meter A anchors 7 days out
    ];
    for (const claim of dead) expect(doc).not.toContain(claim);
  });

  it("SCALING.md and ANTI-BAN.md carry no superseded numbers either", () => {
    const scaling = readFileSync(join(process.cwd(), "SCALING.md"), "utf8");
    const antiban = readFileSync(join(process.cwd(), "ANTI-BAN.md"), "utf8");
    for (const claim of [
      "One host. 40",
      "above 40",
      "**3 hosts**",
      "**8 hosts**",
      "**13 hosts**",
    ]) {
      expect(scaling).not.toContain(claim);
    }
    // The deploy line must carry the flag that is the real request ceiling.
    expect(scaling).toContain("--timeout 90");
    // Placement is geo-ranked. The phrase may appear in the sentence that
    // CORRECTS the old claim, so what is pinned absent is the claim itself.
    expect(antiban).not.toContain("Multi-host round-robin");
    expect(antiban).not.toContain("hosts for round-robin");
    expect(antiban).toContain("Geo-aware host placement");
    expect(antiban).toContain("1.2-4.5s");
  });

  it("the doc never claims the engine is ban-safe (the irreducible-risk rule)", () => {
    expect(doc.toLowerCase()).not.toContain("ban-proof");
    expect(doc.toLowerCase()).not.toContain("ban safe");
    expect(doc.toLowerCase()).not.toContain("ban-safe");
    // ...and the pre-link consent copy carries the same honesty: the limits
    // LOWER the risk, nothing removes it.
    const consent = readFileSync(join(process.cwd(), "src/components/WaConnect.tsx"), "utf8");
    expect(consent).toContain("lower that risk - they cannot remove it");
  });
});
