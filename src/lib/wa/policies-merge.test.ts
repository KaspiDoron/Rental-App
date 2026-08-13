import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Controllable storage: policy rows + config keys per test.
const state = {
  rows: [] as Array<{ key: string; value: string }>,
  config: {} as Record<string, string | undefined>,
  /** Simulate a Supabase outage on the policies table (strict read). */
  policiesDown: false,
  /** Simulate the config store throwing (PACING_MODE / FAST_DISPATCH reads). */
  configThrows: false,
};
vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string) =>
    table === "whatsapp_security_policies" ? state.rows : [],
  // getPolicies reads its rows STRICTLY now (owner report 3, 3.4 #5) so an
  // outage is distinguishable from "no overrides" - the mock must answer the
  // policies table on the strict helper or every merge test reads vacuous.
  sbSelectStrict: async (table: string) => {
    if (table === "whatsapp_security_policies") {
      if (state.policiesDown) return { error: "unavailable" as const };
      return { rows: state.rows };
    }
    return { error: "missing" as const };
  },
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbInsertClaim: async () => "won",
  getConfig: async (name: string) => {
    if (state.configThrows) throw new Error("config store down");
    return state.config[name];
  },
  setConfig: async () => ({ ok: true, persistent: false }),
  supabaseConfigured: () => true,
}));

import { getPolicies } from "../wa-guard";

const g = globalThis as unknown as {
  __wd_wa_policies__?: unknown;
  __wd_wa_policies_lastgood__?: unknown;
  __wd_wa_pacing_raw__?: unknown;
};

beforeEach(() => {
  state.rows = [];
  state.config = {};
  state.policiesDown = false;
  state.configThrows = false;
  g.__wd_wa_policies__ = undefined;
  g.__wd_wa_policies_lastgood__ = undefined;
  g.__wd_wa_pacing_raw__ = undefined;
});

// The exact production failure: the owner's switch, inverted by a spelling.
// A fast_dispatch row of "on" used to read as FALSE (`value === "true"`),
// silently re-arming the business-hours park that deferred a 19:16 batch to
// 05:38 the next morning.

describe("getPolicies - the merged truth cannot be flipped by a spelling", () => {
  it("fast dispatch defaults OFF with no config and no rows", async () => {
    // The owner's speed-vs-safety call: cold introductions respect the
    // recipient's business hours. Agent REPLIES skip that clamp regardless, so
    // this costs no reply latency - only night-time first contact, which is the
    // pattern WhatsApp meters.
    const p = await getPolicies();
    expect(p.fast_dispatch).toBe(false);
    expect(p.ignore_business_hours).toBe(false);
  });

  it("a fast_dispatch row spelled 'on' keeps fast dispatch ON (the incident)", async () => {
    state.rows = [{ key: "fast_dispatch", value: "on" }];
    const p = await getPolicies();
    expect(p.fast_dispatch).toBe(true);
  });

  it("an explicit OFF row in either dialect is honored", async () => {
    state.rows = [{ key: "fast_dispatch", value: "off" }];
    expect((await getPolicies()).fast_dispatch).toBe(false);
  });

  it("a gibberish row keeps the effective value instead of meaning false", async () => {
    // The claim is about COERCION, not about which way the default points: an
    // unparseable row must leave the effective value alone. It is pinned here
    // against a value that is now TRUE by an explicit config, so the assertion
    // still fails if "maybe" ever starts meaning false.
    state.config = { FAST_DISPATCH: "on" };
    state.rows = [{ key: "ignore_business_hours", value: "maybe" }];
    const p = await getPolicies();
    expect(p.ignore_business_hours).toBe(true); // derived from FAST_DISPATCH=on
  });

  it("FAST_DISPATCH config accepts both dialects and ignores gibberish", async () => {
    state.config = { FAST_DISPATCH: "no" };
    expect((await getPolicies()).fast_dispatch).toBe(false);

    (globalThis as unknown as { __wd_wa_policies__?: unknown }).__wd_wa_policies__ = undefined;
    state.config = { FAST_DISPATCH: "banana" };
    // Gibberish keeps the DEFAULT, and the default is now off. That direction
    // matters: an unreadable config must never hand cold outreach a 24/7
    // licence.
    expect((await getPolicies()).fast_dispatch).toBe(false);
  });

  it("out-of-range numeric rows are ignored, in-range ones apply", async () => {
    state.rows = [
      { key: "business_hour_start", value: "700" }, // typo'd - ignored
      { key: "min_gap_seconds", value: "20" }, // sane - applied
    ];
    const p = await getPolicies();
    expect(p.business_hour_start).toBe(8);
    expect(p.min_gap_seconds).toBe(20);
  });

  it("an inverted hours window falls back to the shipped window", async () => {
    state.rows = [
      { key: "business_hour_start", value: "20" },
      { key: "business_hour_end", value: "9" },
    ];
    const p = await getPolicies();
    expect(p.business_hour_start).toBe(8);
    expect(p.business_hour_end).toBe(21);
  });

  it("a valid explicit row still overrides the derived flag (most specific wins)", async () => {
    state.config = { FAST_DISPATCH: "on" };
    state.rows = [{ key: "ignore_business_hours", value: "false" }];
    const p = await getPolicies();
    expect(p.fast_dispatch).toBe(true);
    expect(p.ignore_business_hours).toBe(false);
  });
});

// THE FAIL DIRECTION (owner report 3, 3.4 #5). sbSelect used to collapse an
// outage to [] - the same value as "the owner set no overrides" - so every
// cautious dial evaporated for a 60s cache window whenever Supabase wobbled.
// The policy layer must fail toward CAUTION, never toward the mid-band.
describe("the policy layer fails toward caution, never toward looser defaults", () => {
  it("an outage with NO memory serves the CAUTIOUS preset, not balanced", async () => {
    state.policiesDown = true;
    const p = await getPolicies();
    expect(p.min_gap_seconds).toBe(30); // cautious preset
    expect(p.warmup_days).toBe(14);
    expect(p.fast_dispatch).toBe(false);
    expect(p.ignore_business_hours).toBe(false);
  });

  it("an outage WITH memory serves the owner's last-resolved dials", async () => {
    state.rows = [{ key: "min_gap_seconds", value: "20" }];
    expect((await getPolicies()).min_gap_seconds).toBe(20); // resolves + remembers
    g.__wd_wa_policies__ = undefined; // expire the TTL cache, keep last-good
    state.policiesDown = true;
    expect((await getPolicies()).min_gap_seconds).toBe(20); // remembered, not defaulted
  });

  it("the emergency stance is never stored as last-good (it is a stance, not a reading)", async () => {
    state.policiesDown = true;
    await getPolicies();
    expect(g.__wd_wa_policies_lastgood__).toBeUndefined();
  });

  it("a PACING_MODE read failure holds the owner's last-resolved mode", async () => {
    state.config = { PACING_MODE: "cautious" };
    expect((await getPolicies()).min_gap_seconds).toBe(30); // cautious resolved + remembered
    g.__wd_wa_policies__ = undefined;
    state.configThrows = true; // rows still readable, config store down
    expect((await getPolicies()).min_gap_seconds).toBe(30); // mode held, not reverted to balanced
  });
});
