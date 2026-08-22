import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE CAP DID NOT APPLY TO THE ONE ARRANGEMENT IT WAS WRITTEN FOR.
//
// Owner report 8 wave A made the per-host cap REFUSE instead of overfilling,
// because with a single Render box and 50 testers every socket landed on
// 512 MB. But resolveHost opened with `if (hosts.length === 1) return
// hosts[0];` above everything, so on a single-host deployment - today's
// deployment, and the exact case in the commit message - neither the cap nor
// the refusal ever ran.

describe("one host is not an exemption from the cap", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("the single-host path consults the cap", () => {
    const at = evo.indexOf("if (hosts.length === 1) {");
    expect(at).toBeGreaterThan(-1);
    const branch = evo.slice(at, at + 500);
    expect(branch).toMatch(/maxPerHost\(\)/);
    expect(branch).toMatch(/hostUserCounts\(\)/);
    expect(branch).toMatch(/: null;/);
    // The old unconditional escape must be gone.
    expect(evo).not.toMatch(/if \(hosts\.length === 1\) return hosts\[0\];/);
  });

  it("an ALREADY-PLACED user is never evicted by the cap", () => {
    // The cap governs placement. Refusing a user who is already on a full host
    // would break sends for someone who is not the problem - and every send
    // path calls resolveHost, not just the link path.
    const at = evo.indexOf("if (hosts.length === 1) {");
    const branch = evo.slice(at, at + 500);
    expect(branch).toMatch(/if \(stored === hosts\[0\]\.url\) return hosts\[0\];/);
    // The stored read happens before the branch, or it cannot be consulted.
    expect(evo.slice(0, at)).toMatch(/const stored = rows\[0\]\?\.host_url;/);
  });

  it("the multi-host path still keeps a user on their healthy host", () => {
    expect(evo).toMatch(/const h = healthy\.find\(\(x\) => x\.url === stored\);/);
  });

  it("the health probe is still skipped with one host - only the cap is not", () => {
    const at = evo.indexOf("if (hosts.length === 1) {");
    // The branch itself must not probe - there is nothing to fail over TO, and
    // connectInstance probes this host directly a few lines later. Scoped to
    // the branch BODY so the probe that follows it, for the multi-host path,
    // does not read as a violation.
    const body = evo.slice(at, evo.indexOf("\n  }", at));
    expect(body.length).toBeGreaterThan(60);
    expect(body).not.toMatch(/hostHealthy\(/);
  });
});

describe("at capacity says so, instead of blaming the configuration", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("the two null causes get two different messages", () => {
    const at = evo.indexOf("const host = await resolveHost(email, phone);");
    expect(at).toBeGreaterThan(-1);
    const branch = evo.slice(at, at + 900);
    expect(branch).toMatch(/const configured = await getHosts\(\);/);
    expect(branch).toMatch(/configured\.length/);
    expect(branch).toMatch(/at capacity right now/);
    expect(branch).toMatch(/The WhatsApp connector is not set up yet\./);
  });

  it("the capacity message is something a TESTER can act on", () => {
    // The owner-facing "add EVOLUTION_API_URL in Admin -> Keys" answer is
    // useless to the person who actually hits this.
    const m = readCode("src/lib/evolution.ts").match(/"([^"]*at capacity right now[^"]*)"/);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/Try again shortly/);
    expect(m![1]).not.toMatch(/Admin -> Keys/);
  });
});

describe("the daily cold ceiling is OFF by default, as the capacity model intends", () => {
  it("a fixed daily cap is the OLD model and must not bind out of the box", () => {
    // wa/capacity.ts opens by explaining why a fixed 15/day was replaced: the
    // warm-up ramp crushed it to ~2 shops for a whole day and everything parked
    // until tomorrow morning. Wave D wired the dead knob up - correctly - and in
    // doing so silently reinstated that model for every plan above free.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/max_new_contacts_per_day: 0,/);
    expect(guard).not.toMatch(/max_new_contacts_per_day: 15,/);
  });

  it("but the knob still WORKS when an owner sets it", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const dailyIntroCap = Number\(p\.max_new_contacts_per_day\) \|\| 0;/);
    expect(guard).toMatch(/if \(dailyIntroCap > 0\) \{/);
    // Fail-closed on an unreadable count, like every other term in the budget.
    expect(guard).toMatch(/!day \|\| day\.unreadable \? 0 :/);
  });

  it("0 is settable, so the field can be returned to its own default", () => {
    const pv = readCode("src/lib/wa/policy-values.ts");
    expect(pv).toMatch(/max_new_contacts_per_day: \{ kind: "number", min: 0,/);
  });

  it("the admin panel says it is an extra ceiling, not THE limit", () => {
    const admin = read("src/app/api/admin/wa-security/route.ts");
    const at = admin.indexOf("max_new_contacts_per_day: {");
    const entry = admin.slice(at, at + 900);
    expect(entry).toMatch(/0 = off \(the default\)/);
    expect(entry).toMatch(/on top of the plan's rolling window/i);
    // The old copy called it "THE most important limit", which it is not.
    expect(entry).not.toMatch(/THE most important limit/);
  });
});
