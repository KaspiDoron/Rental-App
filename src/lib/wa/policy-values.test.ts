import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { POLICY_SPEC, policyRowValue, validatePolicyWrite } from "./policy-values";

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("policyRowValue - tolerant read heals bad rows", () => {
  it("a flag row spelled 'on' reads as true (the incident inversion)", () => {
    expect(policyRowValue("fast_dispatch", "on", false)).toBe(true);
    expect(policyRowValue("ignore_business_hours", "1", false)).toBe(true);
  });

  it("a flag row spelled 'off'/'no' reads as false", () => {
    expect(policyRowValue("fast_dispatch", "off", true)).toBe(false);
    expect(policyRowValue("engagement_halt", "no", true)).toBe(false);
  });

  it("an unreadable flag row keeps the effective value instead of meaning false", () => {
    expect(policyRowValue("fast_dispatch", "banana", true)).toBe(true);
    expect(policyRowValue("fast_dispatch", "banana", false)).toBe(false);
  });

  it("numbers apply only inside their sane range", () => {
    expect(policyRowValue("business_hour_start", "5", 8)).toBe(5);
    expect(policyRowValue("business_hour_start", "700", 8)).toBe(8); // out of range -> keep
    expect(policyRowValue("min_reply_rate", "0.05", 0.15)).toBe(0.05);
    expect(policyRowValue("min_reply_rate", "15", 0.15)).toBe(0.15); // 15 (percent typo) -> keep
    expect(policyRowValue("min_gap_seconds", "abc", 12)).toBe(12);
  });

  it("an unknown key keeps the current value", () => {
    expect(policyRowValue("mystery_knob", "42", 7)).toBe(7);
  });
});

describe("validatePolicyWrite - the write-side contract", () => {
  it("rejects unknown keys with a legible reason", () => {
    const v = validatePolicyWrite("fast_dispach", "true");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/Unknown policy/);
  });

  it("normalises every flag dialect to true/false and rejects gibberish", () => {
    expect(validatePolicyWrite("fast_dispatch", "on")).toEqual({ ok: true, normalized: "true" });
    expect(validatePolicyWrite("engagement_halt", "NO")).toEqual({ ok: true, normalized: "false" });
    const bad = validatePolicyWrite("fast_dispatch", "maybe");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/on\/off/);
  });

  it("rejects out-of-range numbers with the allowed range in the message", () => {
    const v = validatePolicyWrite("business_hour_start", "700");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/between 0 and 23/);
    expect(validatePolicyWrite("business_hour_start", "9")).toEqual({ ok: true, normalized: "9" });
  });
});

describe("the spec stays in sync with the engine (source-level pins)", () => {
  it("POLICY_SPEC covers exactly the keys of wa-guard's DEFAULTS", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    // Every `key: value,` line of the DEFAULTS object literal.
    const block = guard.slice(
      guard.indexOf("const DEFAULTS: SecurityPolicies = {"),
      guard.indexOf("declare global")
    );
    const keys = [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect(new Set(keys)).toEqual(new Set(Object.keys(POLICY_SPEC)));
  });

  it("getPolicies parses DB rows through the contract, not `=== \"true\"`", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/policyRowValue\(/);
    expect(guard).not.toMatch(/r\.value === "true"/);
    // FAST_DISPATCH uses the shared dialect too, and its fallback is the
    // shipped DEFAULT rather than a hardcoded `true` - an unreadable config
    // must not hand cold outreach a 24/7 licence.
    expect(guard).toMatch(/parseFlag\(fastRaw, DEFAULTS\.fast_dispatch\)/);
    // An inverted hours window falls back to the shipped defaults.
    expect(guard).toMatch(/business_hour_start >= merged\.business_hour_end/);
  });

  it("the admin route validates writes and offers a reset path", () => {
    const route = readCode("src/app/api/admin/wa-security/route.ts");
    expect(route).toMatch(/validatePolicyWrite\(key, value\)/);
    expect(route).toMatch(/deletePolicy\(key\)/);
    expect(route).toMatch(/status: 400/);
    // The hours pair cannot be inverted from the panel.
    expect(route).toMatch(/start >= end/);
  });

  it("CANCEL_GUARD and HUMAN_TAKEOVER parse through the shared dialect", () => {
    expect(readCode("src/lib/wa/cancellations.ts")).toMatch(/parseFlag\(flag, true\)/);
    expect(readCode("src/lib/wa/ingest.ts")).toMatch(
      /parseFlag\(await getConfig\("HUMAN_TAKEOVER"\), true\)/
    );
  });

  it("the documented kill switches are actually settable from Admin - Keys", () => {
    const cfg = readCode("src/lib/config.ts");
    expect(cfg).toMatch(/name: "FAST_DISPATCH"/);
    expect(cfg).toMatch(/name: "CANCEL_GUARD"/);
  });
});
