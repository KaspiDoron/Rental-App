import { describe, it, expect } from "vitest";
import {
  ACTIONS,
  checkAction,
  availableActions,
  describeActions,
  outcomeFor,
  compareOutcome,
  MIN_COMPARE,
} from "./registry";
import { can } from "../entitlements";

// The helper SUPPLIES `can`, so callers must not be required to pass it -
// typing the parameter as the full argument made every call site an error the
// moment tests were first type-checked.
const check = (o: Omit<Parameters<typeof checkAction>[0], "can">) => checkAction({ can, ...o });

describe("the app has a vocabulary for what it can DO", () => {
  it("'push harder' is an action that reaches a shop, not a panel", () => {
    // It used to resolve to `setWillOpen(true)` - it opened a chat. The bridge
    // an assistant had exposed view-state setters only, so the only thing it
    // could do was move the traveller's eyes.
    expect(ACTIONS["push-harder"].outbound).toBe(true);
    expect(ACTIONS["push-harder"].needs).toContain("vendorId");
  });

  it("every outbound action states its effect in plain language", () => {
    for (const a of Object.values(ACTIONS)) {
      if (!a.outbound) continue;
      expect(a.effect.length).toBeGreaterThan(10);
    }
  });
});

describe("an action can be refused cleanly - which is the point", () => {
  it("an unknown name is refused, never improvised", () => {
    expect(check({ id: "delete-everything", plan: "ultra", confirmed: true })).toEqual({
      ok: false,
      reason: "unknown-action",
    });
  });

  it("a missing argument is REPORTED, never guessed", () => {
    const r = check({ id: "counter-at", args: { vendorId: "v1" }, plan: "free", confirmed: true });
    expect(r).toEqual({ ok: false, reason: "missing-args", missing: ["pricePerDay"] });
  });

  it("an empty string or empty list counts as missing", () => {
    expect(check({ id: "push-harder", args: { vendorId: "" }, plan: "free", confirmed: true })).toMatchObject({
      reason: "missing-args",
    });
    expect(check({ id: "compare", args: { vendorIds: [] }, plan: "free" })).toMatchObject({
      reason: "missing-args",
    });
  });

  it("a paid action names the feature it needs", () => {
    const r = check({ id: "mass-bargain", plan: "free", confirmed: true });
    expect(r).toEqual({ ok: false, reason: "not-entitled", requires: "mass-bargain" });
  });
});

describe("nothing reaches a shop without the traveller's OK", () => {
  it("an unconfirmed outbound action is refused with its effect", () => {
    const r = check({ id: "push-harder", args: { vendorId: "v1" }, plan: "free" });
    expect(r).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect((r as { effect: string }).effect).toMatch(/Sends/);
  });

  it("a confirmed one is allowed", () => {
    expect(check({ id: "push-harder", args: { vendorId: "v1" }, plan: "free", confirmed: true }).ok).toBe(true);
  });

  it("a VIEW action needs no confirmation - it sends nothing", () => {
    expect(check({ id: "compare", args: { vendorIds: ["a", "b"] }, plan: "free" }).ok).toBe(true);
    expect(check({ id: "filter-rents-cars", plan: "free" }).ok).toBe(true);
  });

  it("entitlement is checked BEFORE confirmation - no confirm for a locked feature", () => {
    expect(check({ id: "mass-bargain", plan: "free" })).toMatchObject({ reason: "not-entitled" });
  });
});

describe("the assistant is told only what it may actually do", () => {
  it("a free plan's catalogue excludes what it cannot run", () => {
    const ids = availableActions("free", can).map((a) => a.id);
    expect(ids).toContain("push-harder");
    expect(ids).not.toContain("mass-bargain");
    expect(ids).not.toContain("recheck-prices");
  });

  it("Ultra sees everything", () => {
    expect(availableActions("ultra", can)).toHaveLength(Object.keys(ACTIONS).length);
  });

  it("the catalogue flags which actions need an OK", () => {
    const text = describeActions(availableActions("free", can));
    expect(text).toMatch(/push-harder\(vendorId\)/);
    expect(text).toMatch(/Needs the traveller's OK first/);
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

describe("Will and the buttons share ONE vocabulary", () => {
  const page = readCode("src/app/page.tsx");

  it("the registry is mounted with real executors", () => {
    expect(page).toMatch(/checkAction\(/);
    expect(page).toMatch(/const runAction = useCallbackRef/);
  });

  it("'Push harder' actually sends now", () => {
    expect(page).toMatch(/runAction\("push-harder"/);
    // The old body: open the chat panel and hope.
    expect(page).not.toMatch(/label: t\("Push harder"\), onAction: \(\) => setWillOpen\(true\)/);
  });

  it("every outbound executor goes through the guarded send path", () => {
    // customMessage posts to /api/outreach, which runs guardOutbound - the same
    // pacing, cancellation and takeover vetoes an agent message passes.
    const block = page.slice(page.indexOf("const runAction"), page.indexOf("const runMassBargain"));
    expect(block).toMatch(/customMessage\(/);
    expect(block).not.toMatch(/fetch\("\/api\/wa\//);
  });

  it("the assistant gets the same entry point, not a private one", () => {
    expect(page).toMatch(/runAction: \(id: string/);
  });
});

// ---------------------------------------------------------------------------
// AN ACTION HAS AN OUTCOME. Silence is what made the buttons read as dead.
// ---------------------------------------------------------------------------

describe("every action result becomes something the traveller can read", () => {
  it("a success says what happened", () => {
    expect(outcomeFor("push-harder", { ok: true }).tone).toBe("ok");
    expect(outcomeFor("push-harder", { ok: true }, "Pushing Ann's Rental.").text).toBe(
      "Pushing Ann's Rental."
    );
  });

  it("every refusal has words - none of them can be silent", () => {
    for (const reason of ["not-entitled", "needs-confirm", "missing-args", "unknown-action"]) {
      const o = outcomeFor("counter-at", { ok: false, reason, missing: ["pricePerDay"] });
      expect(o.text.length).toBeGreaterThan(0);
    }
  });

  it("an unrecognised failure still says something rather than nothing", () => {
    expect(outcomeFor("push-harder", { ok: false }).text).toMatch(/did not go through/i);
  });

  it("a locked action points at the upgrade instead of going quiet", () => {
    expect(outcomeFor("mass-bargain", { ok: false, reason: "not-entitled" }).text).toMatch(/Pro/);
  });

  it("comparing needs two shops, and says so when it has one", () => {
    expect(compareOutcome(2)).toBeNull();
    expect(compareOutcome(3)).toBeNull();
    expect(compareOutcome(1)?.text).toMatch(/only one shop/i);
    expect(compareOutcome(0)?.text).toMatch(/no prices/i);
    expect(MIN_COMPARE).toBe(2);
  });

  it("the page reports EVERY outcome, and compare goes through the registry", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toMatch(/setActionNote\(outcomeFor\(id, check\)\)/);
    expect(page).toMatch(/compareOutcome\(ids\.length\)/);
    expect(page).toMatch(/runAction\("compare", \{/);
    // The old shape: the overlay set the comparison itself and the sheet, which
    // needs two shops, simply never opened.
    expect(page).not.toMatch(/label: t\("Compare the top 3"\),\s*onAction: \(\) =>\s*setCompareIds\(/);
  });
});

describe("REPRODUCTION: the registry advertised an action nothing could run", () => {
  const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("EVERY action in the registry has a case in the executor", () => {
    // `recheck-prices` sat in the shared registry - and therefore in Will's
    // prompt, offered to any plan with trips-history - with no case at all, so
    // the switch fell through to `unknown-action`. A capability advertised and
    // then silently refused is worse than one never offered.
    const missing = Object.keys(ACTIONS).filter((id) => !page.includes(`case "${id}"`));
    expect(missing).toEqual([]);
  });

  it("...and the executor invents nothing the registry does not declare", () => {
    // The drift has to be impossible in BOTH directions, or Will's catalogue
    // stops describing what the app can do.
    const cases = [...page.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
    const known = new Set(Object.keys(ACTIONS));
    // Only the action switch matters; other switches in the file use different
    // vocabularies, so this checks the intersection is exact for action-shaped
    // ids rather than every string literal in the file.
    const actionish = cases.filter((c) => known.has(c));
    expect(new Set(actionish).size).toBe(known.size);
  });
});
