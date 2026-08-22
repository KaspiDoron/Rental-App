import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveOffset } from "./business-hours";
import { effectiveHourCap, warmupNewContactFactor } from "./capacity";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, wave D - the new-number defence, which was largely decorative.

describe("the clock gate covers south-east Asia", () => {
  it("THE 03:00 SEND: the five missing countries are known now", () => {
    // resolveOffset returning known:false does not merely lose precision - it
    // DISABLES the business-hours gate entirely (`if (known && ...)`), so a
    // cold first contact to Siem Reap could fire at 3am. Core scooter markets.
    for (const [digits, off] of [
      ["85512345678", 7], // Cambodia
      ["85620123456", 7], // Laos
      ["959123456789", 6.5], // Myanmar
      ["8801712345678", 6], // Bangladesh
      ["9607712345", 5], // Maldives
    ] as const) {
      const r = resolveOffset(digits);
      expect(r.known, digits).toBe(true);
      expect(r.off, digits).toBe(off);
    }
  });

  it("the region strings resolve too - a geocoded label is the better signal", () => {
    expect(resolveOffset("000", "Siem Reap, Cambodia").off).toBe(7);
    expect(resolveOffset("000", "Vientiane, Laos").off).toBe(7);
    expect(resolveOffset("000", "Yangon, Myanmar").off).toBe(6.5);
    expect(resolveOffset("000", "Dhaka, Bangladesh").off).toBe(6);
  });

  it("LONGEST PREFIX WINS, by construction rather than by hope", () => {
    // "86" (China) sat above "852"/"886" in the raw list. All three share
    // offset 8 so nothing broke - but the next prefix added inherits the trap.
    expect(resolveOffset("85212345678").off).toBe(8); // Hong Kong, not shadowed
    expect(resolveOffset("886912345678").off).toBe(8); // Taiwan
    expect(resolveOffset("8613800138000").off).toBe(8); // China
    // And the new 855/856 must not be eaten by "85"-anything either.
    expect(resolveOffset("85512345678").off).toBe(7);
    expect(read("src/lib/wa/business-hours.ts")).toMatch(/sort\(\s*\(a, b\) => b\[0\]\.length - a\[0\]\.length\s*\)/);
  });

  it("an unknown prefix still stands the gate down - a false 'closed' is worse", () => {
    expect(resolveOffset("99912345").known).toBe(false);
  });
});

describe("the warm-up ramp can actually bite", () => {
  it("THE INERT RAMP: a day-0 hour cap is now below a warmed one", () => {
    // hourCap === newContacts for every plan and warmupFactor floors at 0.85,
    // so `Math.max(cap.newContacts, ...)` swallowed the ramp whole - the
    // function returned the same number at every age for pro and ultra.
    for (const plan of ["ultra", "pro", "free"] as const) {
      expect(effectiveHourCap(plan, 6, 0, 7)).toBeLessThan(effectiveHourCap(plan, 6, 7, 7));
    }
  });

  it("...and it stays gentle - this is a ramp, not a lockout", () => {
    expect(effectiveHourCap("free", 6, 0, 7)).toBeGreaterThan(0);
    expect(warmupNewContactFactor(0, 7)).toBe(0.5);
    expect(warmupNewContactFactor(7, 7)).toBe(1);
  });

  it("the DAILY ceiling ramps too - it was the only thing left unscaled", () => {
    const guard = read("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const warmDay = warmupNewContactFactor\(ageDaysOf\(rep\), p\.warmup_days, warmMeasuredRate\)/);
    // The ramp still multiplies the daily ceiling. `warmDay` reaches it through
    // Math.max against the ramp floor now (see the next test) - what this
    // guards, that day_cap is scaled by warm-up age at all rather than being a
    // flat number for a day-0 and a six-month-old link alike, is unchanged.
    expect(guard).toMatch(/p\.day_cap \* jitter \* Math\.max\(warmDay, rampFloor\)/);
  });

  it("...but it can NEVER gag a reply - reciprocal traffic is protective", () => {
    // The ceiling covers all sends including replies. Ramping it to zero would
    // mean refusing to answer a shop that wrote to us: broken to the traveller
    // AND damaging to the reply ratio that keeps the number safe.
    const guard = read("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const WARMUP_DAY_FLOOR = 40;/);
    // THE FLOOR IS ON THE RAMP, NOT ON THE OWNER'S NUMBER. Applying it to the
    // whole ceiling raised any owner-set day_cap below 40 back up to 40 - so
    // following the WA security panel's own advice and clamping to 30 while
    // watching a wobbling number produced 40, HIGHER than what was typed. Since
    // the ramped default never approaches the floor, that was the floor's only
    // observable effect: neutralising the owner's clamp. Clamping the
    // MULTIPLIER keeps a warmed-down number able to answer a full day of real
    // conversation while leaving day_cap meaning what the owner set.
    expect(guard).toMatch(/const rampFloor = p\.day_cap > 0 \? Math\.min\(1, WARMUP_DAY_FLOOR \/ p\.day_cap\) : 1;/);
    expect(guard).not.toMatch(/Math\.max\(\s*WARMUP_DAY_FLOOR,\s*Math\.round\(p\.day_cap/);
  });
});

describe("the owner's safety knob is no longer dead", () => {
  const guard = read("src/lib/wa-guard.ts");

  it("THE DEAD CONTROL: max_new_contacts_per_day now binds admission", () => {
    // Declared, defaulted, validated, rendered in the WA-security panel - and
    // read by no send path. An owner lowering it during a beta would watch the
    // field save and change nothing.
    expect(guard).toMatch(/const dailyIntroCap = Number\(p\.max_new_contacts_per_day\) \|\| 0;/);
    expect(guard).toMatch(/dayHeadroom/);
    expect(guard).toMatch(/openHeadroom,\s*monthHeadroom,\s*dayHeadroom\s*\)/);
  });

  it("0 or unset means no extra ceiling - existing deployments unchanged", () => {
    expect(guard).toMatch(/let dayHeadroom = Number\.POSITIVE_INFINITY;/);
    expect(guard).toMatch(/if \(dailyIntroCap > 0\) \{/);
  });

  it("an unreadable count fails CLOSED, like the rest of this budget", () => {
    expect(guard).toMatch(/!day \|\| day\.unreadable \? 0 :/);
  });
});
