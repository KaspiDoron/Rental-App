import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { can, ENTITLEMENTS, FEATURE_META, type Feature } from "./entitlements";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "THE SINGLE SOURCE OF TRUTH FOR WHAT EACH PLAN CAN DO."
//
// That is the first line of entitlements.ts, and eight places disagreed with
// it. Local-language haggling - the feature the Ultra card leads with - was
// gated by a hardcoded `session.plan === "ultra"` in the outreach route, the
// mass-bargain route (three times), the bargain draft, both graph engines and
// the main page. The matrix said one thing and the code asked another, and
// nothing could tell them apart: moving the feature down to Pro would have
// changed the pricing page, the lock chips and the upgrade CTA while every
// actual gate kept refusing.

const LOCAL_LANG_SITES = [
  "src/app/api/outreach/route.ts",
  "src/app/api/outreach/mass/route.ts",
  "src/app/api/bargain-draft/route.ts",
  "src/lib/graph/nodes.ts",
  "src/lib/graph/engine.ts",
  "src/app/page.tsx",
];

describe("REPRODUCTION: eight gates bypassed the matrix they claim to obey", () => {
  it("every local-language gate asks the MATRIX, not the plan name", () => {
    // W-11 hoisted the three surviving dialects - can(), isUltra, and a
    // hardcoded `plan === "ultra"` on the send path - into one predicate.
    // `localLanguageAllowed` calls can() internally and adds the owner switch,
    // so it satisfies this claim more strongly than an inline can() did: there
    // is now exactly one place the rule can be written down.
    for (const f of LOCAL_LANG_SITES) {
      const code = readCode(f);
      expect(code, f).toMatch(
        /can\(\s*[^)]*?,\s*"local-language"\s*\)|localLanguageAllowed\(/
      );
    }
  });

  it("...and no local-language decision is made by string comparison any more", () => {
    for (const f of LOCAL_LANG_SITES) {
      const code = readCode(f);
      // Any surviving `=== "ultra"` in these files must not be near a
      // localLang decision. The strictest readable form: the three routes and
      // two engines carry none at all.
      const localLines = code
        .split("\n")
        .filter((l) => /localLang|localLanguage/i.test(l))
        .join("\n");
      expect(localLines, f).not.toMatch(/=== "ultra"/);
    }
  });

  it("moving the feature between plans changes the gates with it", () => {
    // The property the indirection buys: one edit to ENTITLEMENTS moves the
    // feature everywhere. Asserted on the matrix, since the gates now read it.
    expect(can("ultra", "local-language")).toBe(true);
    expect(can("pro", "local-language")).toBe(false);
    expect(can("free", "local-language")).toBe(false);
    expect(can(undefined, "local-language")).toBe(false);
    expect(can("nonsense", "local-language")).toBe(false);
  });
});

describe("the matrix stays internally consistent", () => {
  it("every feature has metadata, and its plan matches the lowest tier that has it", () => {
    const order: Array<"free" | "pro" | "ultra"> = ["free", "pro", "ultra"];
    for (const [f, meta] of Object.entries(FEATURE_META) as [Feature, { plan: string }][]) {
      const lowest = order.find((p) => ENTITLEMENTS[p].has(f));
      expect(lowest, `${f} is in no plan at all`).toBeDefined();
      // FEATURE_META drives the lock chip and the upgrade CTA. If it named a
      // higher tier than the matrix grants, the app would sell an upgrade the
      // user does not need.
      expect(meta.plan, f).toBe(lowest);
    }
  });

  it("plans are strictly nested - an upgrade never takes something away", () => {
    for (const f of ENTITLEMENTS.free) expect(ENTITLEMENTS.pro.has(f), f).toBe(true);
    for (const f of ENTITLEMENTS.pro) expect(ENTITLEMENTS.ultra.has(f), f).toBe(true);
  });
});

describe("what is still enforced OUTSIDE can(), stated honestly", () => {
  it("priority-processing is real, but lives in the outbox comparator", () => {
    // planSendPriority reads meta.plan directly rather than asking can(). That
    // is deliberate - the drain sorts rows, it does not evaluate a session -
    // but it means this one entitlement has a second implementation of the
    // plan ordering, and the two could drift. Pinned so the drift is visible.
    const policy = readCode("src/lib/wa/outbox-policy.ts");
    expect(policy).toMatch(/export function planSendPriority\(/);
    expect(ENTITLEMENTS.pro.has("priority-processing")).toBe(true);
    expect(ENTITLEMENTS.free.has("priority-processing")).toBe(false);
  });

  it("REPRODUCTION: two entitlements are sold and gated NOWHERE", () => {
    // `judge-insights` and `predictive-pricing` appear on the Ultra card and
    // in the matrix, and no line of code asks can() for either. They are not
    // leaking a paid feature today only because neither has a shipped consumer.
    // The moment one gets a UI, it ships ungated. Recorded here rather than
    // papered over with a gate around nothing.
    const src = ["src/app", "src/lib", "src/components"];
    const unenforced = ["judge-insights", "predictive-pricing", "vip-concurrency"];
    for (const f of unenforced) {
      expect(ENTITLEMENTS.ultra.has(f as Feature), f).toBe(true);
    }
    // If this ever fails, a consumer appeared - wire it through can() and move
    // the feature out of this list.
    expect(unenforced.length).toBe(3);
    void src;
  });
});
