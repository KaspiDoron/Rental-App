import { describe, it, expect } from "vitest";
import { ACTIONS, checkAction, availableActions, describeActions } from "./registry";
import { can } from "../entitlements";

const check = (o: Parameters<typeof checkAction>[0]) => checkAction({ can, ...o });

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
