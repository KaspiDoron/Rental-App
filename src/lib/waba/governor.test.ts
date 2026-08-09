import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const config: Record<string, string | null> = {};
let leadRows: unknown = { rows: [] };

vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
  sbSelectStrict: async () => leadRows,
}));

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
  leadRows = { rows: [] };
});

const tails = (n: number, distinct = true) =>
  Array.from({ length: n }, (_, i) => ({ agency_tail: distinct ? `t${i}` : "same", id: i }));

// FOUR BUDGETS, ONE ADMISSION, AND IT FAILS CLOSED IN EVERY DIRECTION.
//
// These are fleet-wide, not per-agency: a mistake here degrades an asset every
// user shares at once. That is why this governor's fail direction is the
// OPPOSITE of the warm-up gate's - there a wrong refusal costs a sale, here a
// wrong send costs quality rating on an account we rent and cannot replace.

describe("the emergency stop is absolute", () => {
  it("WABA_KILL halts everything before any budget is read", async () => {
    const { governorVerdict } = await import("./governor");
    config.WABA_KILL = "on";
    const v = await governorVerdict();
    expect(v.allowed).toBe(false);
    expect(v.binding).toBe("kill-switch");
  });

  it("its ABSENCE means running - a config wobble must not re-arm sending", async () => {
    // Deliberately the opposite default from WABA_ENABLED. That flag guards
    // whether the feature exists; this one is flipped during an incident, and a
    // missing row silently un-flipping it is the failure this avoids.
    const { governorVerdict } = await import("./governor");
    const v = await governorVerdict();
    expect(v.binding).not.toBe("kill-switch");
  });
});

describe("quality rating is an existential asset, not a metric", () => {
  it("RED stops first contact entirely rather than throttling", async () => {
    // The WABA is rented: it sits under the provider's verified portfolio and a
    // complaint spike ends the account with someone else's decision.
    const { governorVerdict } = await import("./governor");
    config.WABA_QUALITY_RATING = "RED";
    const v = await governorVerdict();
    expect(v.allowed).toBe(false);
    expect(v.binding).toBe("quality");
  });

  it("YELLOW still sends but says so out loud", async () => {
    const { governorVerdict } = await import("./governor");
    config.WABA_QUALITY_RATING = "YELLOW";
    const v = await governorVerdict();
    expect(v.allowed).toBe(true);
    expect(v.reason).toMatch(/YELLOW/);
  });

  it("an unrecognised value is UNKNOWN, never optimistically GREEN", async () => {
    const { qualityRating } = await import("./governor");
    config.WABA_QUALITY_RATING = "probably fine";
    expect(await qualityRating()).toBe("UNKNOWN");
  });
});

describe("the tier meters unique AGENCIES, not travellers", () => {
  it("many leads to one agency consume one slot", async () => {
    // The reading that counted travellers concluded the platform allowed about
    // six searches a day company-wide. It was wrong by two orders of magnitude,
    // because our recipients are a small shared set that a district exhausts in
    // the tens.
    const { governorVerdict } = await import("./governor");
    config.WABA_TIER_UNIQUE_PER_DAY = "10";
    leadRows = { rows: tails(50, false) };
    const v = await governorVerdict();
    expect(v.allowed).toBe(true);
    expect(v.headroom.tierRemaining).toBe(9);
  });

  it("distinct agencies do consume the tier", async () => {
    const { governorVerdict } = await import("./governor");
    config.WABA_TIER_UNIQUE_PER_DAY = "10";
    leadRows = { rows: tails(10) };
    const v = await governorVerdict();
    expect(v.allowed).toBe(false);
    expect(v.binding).toBe("tier");
  });

  it("only TEMPLATE-lane sends are counted", async () => {
    // Free-form traffic inside a service window does not count against the tier.
    // Counting it would throttle on volume the platform does not meter - which
    // is exactly what the design works to move traffic into.
    const gov = (await import("fs")).readFileSync("src/lib/waba/governor.ts", "utf8");
    expect(gov).toMatch(/lane=eq\.template/);
  });
});

describe("spend is bounded only when a ceiling exists", () => {
  it("an unset ceiling reports unknown headroom rather than infinity", async () => {
    // Unset is the owner not having chosen, not "unlimited by accident".
    const { governorVerdict } = await import("./governor");
    const v = await governorVerdict();
    expect(v.allowed).toBe(true);
    expect(v.headroom.spendRemainingUsd).toBeNull();
  });

  it("a reached ceiling stops sending", async () => {
    const { governorVerdict } = await import("./governor");
    config.WABA_DAILY_SPEND_CEILING_USD = "1";
    config.WABA_TEMPLATE_COST_USD = "0.5";
    config.WABA_TIER_UNIQUE_PER_DAY = "1000";
    leadRows = { rows: tails(2) };
    const v = await governorVerdict();
    expect(v.allowed).toBe(false);
    expect(v.binding).toBe("spend");
  });
});

describe("an unreadable budget refuses", () => {
  it("it holds rather than guessing, and says which way it failed", async () => {
    const { governorVerdict } = await import("./governor");
    leadRows = { error: "unavailable" };
    const v = await governorVerdict();
    expect(v.allowed).toBe(false);
    expect(v.unreadable).toBe(true);
    expect(v.reason).toMatch(/holding until they are readable/);
  });

  it("a MISSING table is not an outage - a fresh install has sent nothing", async () => {
    const { governorVerdict } = await import("./governor");
    leadRows = { error: "missing" };
    const v = await governorVerdict();
    expect(v.unreadable).toBe(false);
    expect(v.allowed).toBe(true);
  });
});
