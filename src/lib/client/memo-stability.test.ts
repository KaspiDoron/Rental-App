import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { reconcileRecord } from "./reconcile";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE MEMO THAT COULD NOT HOLD.
//
// `memo(VendorCard)` compares props by reference. `reconcileList` was built so
// that a poll touching one shop re-renders one card - and then the same poll
// handed every card a brand-new `agentPending` object and two brand-new handler
// closures, which un-memoised the entire board anyway. A memo defeated by the
// props passed alongside it is worse than no memo: it costs the comparison and
// buys nothing, while looking like the problem is solved.

describe("REPRODUCTION: a lookup rebuilt every tick re-renders every card", () => {
  it("an unchanged record keeps its EXACT reference", () => {
    const before = { a: { count: 1, sending: false }, b: { count: 0, sending: true } };
    const next = { a: { count: 1, sending: false }, b: { count: 0, sending: true } };
    expect(reconcileRecord(before, next)).toBe(before);
  });

  it("...and an unchanged ENTRY keeps its reference even when a sibling moved", () => {
    // This is the part that matters for the memo: shop B advancing must not
    // re-render shop A's card.
    const before = { a: { count: 1, sending: false }, b: { count: 0, sending: false } };
    const next = { a: { count: 1, sending: false }, b: { count: 2, sending: true } };
    const merged = reconcileRecord(before, next);
    expect(merged).not.toBe(before);
    expect(merged.a).toBe(before.a);
    expect(merged.b).toBe(next.b);
  });

  it("a value that really changed is the new one", () => {
    const before = { a: { count: 1, sending: false } };
    const next = { a: { count: 1, sending: true } };
    expect(reconcileRecord(before, next).a).toBe(next.a);
  });

  it("a key that disappeared is a change - a finished agent stops reporting busy", () => {
    const before = { a: { count: 1, sending: true } };
    const merged = reconcileRecord(before, {});
    expect(merged).not.toBe(before);
    expect(merged.a).toBeUndefined();
  });

  it("an added key is a change", () => {
    const before: Record<string, { count: number }> = {};
    const next = { a: { count: 1 } };
    const merged = reconcileRecord(before, next);
    expect(merged).not.toBe(before);
    expect(merged.a).toBe(next.a);
  });

  it("empty to empty is still the same reference", () => {
    const before = {};
    expect(reconcileRecord(before, {})).toBe(before);
  });
});

describe("the page stops handing the memo new props it did not need to", () => {
  const page = readCode("src/app/page.tsx");

  it("agentPending is reconciled, not replaced", () => {
    expect(page).toMatch(/setAgentPending\(\(prev\) =>\s*reconcileRecord\(/);
    expect(page).not.toMatch(/setAgentPending\(\s*d\.agentPending &&/);
  });

  it("no inline arrow survives on the card", () => {
    // `onX={(v) => setState(v)}` allocates a new function on every render of
    // the page and hands it to a memo'd child.
    const cardProps = page.slice(page.indexOf("<VendorCard"), page.indexOf("<VendorCard") + 1400);
    expect(cardProps).not.toMatch(/=\{\(\w+\) =>/);
    expect(page).toMatch(/const onLocationRequest = useCallbackRef\(/);
    expect(page).toMatch(/const onOpenThread = useCallbackRef\(/);
  });
});

describe("the brand faces are ours, not a third party's", () => {
  const layout = readCode("src/app/layout.tsx");
  const css = readCode("src/app/globals.css");

  it("REPRODUCTION: the render-blocking Google Fonts stylesheet is gone", () => {
    expect(layout).not.toMatch(/fonts\.googleapis\.com/);
    expect(layout).not.toMatch(/fonts\.gstatic\.com/);
  });

  it("both families are self-hosted through next/font", () => {
    expect(layout).toMatch(/from "next\/font\/google"/);
    expect(layout).toMatch(/const nunito = Nunito\(\{/);
    expect(layout).toMatch(/const baloo = Baloo_2\(\{/);
  });

  it("the fallback face is metric-matched, so the swap shifts nothing", () => {
    expect(layout.match(/adjustFontFallback: true/g)?.length).toBe(2);
    expect(layout.match(/display: "swap"/g)?.length).toBe(2);
  });

  it("the variables reach the stylesheet that actually uses them", () => {
    expect(layout).toMatch(/className=\{`\$\{nunito\.variable\} \$\{baloo\.variable\}`\}/);
    expect(css).toMatch(/--font-body: var\(--wd-font-body\)/);
    expect(css).toMatch(/--font-display: var\(--wd-font-display\)/);
  });
});
