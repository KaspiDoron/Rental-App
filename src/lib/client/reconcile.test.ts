import { describe, it, expect } from "vitest";
import { mergeIfChanged, reconcileList, staggerIndex, MAX_STAGGER_INDEX } from "./reconcile";

interface Row {
  id: string;
  stage?: string;
  offer?: { pricePerDay: number } | null;
  tags?: string[];
}

describe("an unchanged item keeps its exact object", () => {
  it("a no-op patch returns the SAME reference", () => {
    // This is the whole contract. `memo(VendorCard)` compares props by
    // reference, so a rebuilt-but-identical object is a new prop and the card
    // re-renders - twenty of them, twice per six-second poll cycle.
    const row: Row = { id: "a", stage: "found" };
    expect(mergeIfChanged(row, { stage: "found" })).toBe(row);
  });

  it("a real change returns a NEW object", () => {
    const row: Row = { id: "a", stage: "found" };
    const next = mergeIfChanged(row, { stage: "rfq-sent" });
    expect(next).not.toBe(row);
    expect(next.stage).toBe("rfq-sent");
  });

  it("undefined in a patch means 'no opinion', not 'clear it'", () => {
    const row: Row = { id: "a", stage: "found" };
    expect(mergeIfChanged(row, { stage: undefined })).toBe(row);
  });

  it("compares nested values, not references", () => {
    // The polls rebuild these objects every tick; comparing by reference would
    // make every one of them look changed.
    const row: Row = { id: "a", offer: { pricePerDay: 500 }, tags: ["delivery"] };
    expect(mergeIfChanged(row, { offer: { pricePerDay: 500 }, tags: ["delivery"] })).toBe(row);
    expect(mergeIfChanged(row, { offer: { pricePerDay: 450 } })).not.toBe(row);
    expect(mergeIfChanged(row, { tags: ["delivery", "no-deposit"] })).not.toBe(row);
  });

  it("null and a missing value are not the same thing", () => {
    const row: Row = { id: "a", offer: { pricePerDay: 500 } };
    expect(mergeIfChanged(row, { offer: null })).not.toBe(row);
  });
});

describe("a poll that changes one shop re-renders one card", () => {
  const rows: Row[] = [
    { id: "a", stage: "found" },
    { id: "b", stage: "found" },
    { id: "c", stage: "found" },
  ];

  it("the untouched rows keep their references", () => {
    const next = reconcileList(rows, (r) => (r.id === "b" ? { stage: "rfq-sent" } : null));
    expect(next[0]).toBe(rows[0]);
    expect(next[2]).toBe(rows[2]);
    expect(next[1]).not.toBe(rows[1]);
  });

  it("a poll that changes NOTHING returns the same ARRAY", () => {
    // So a useMemo or an effect keyed on the list is not woken either - the
    // six-second heartbeat costs nothing when nothing happened.
    expect(reconcileList(rows, () => ({ stage: "found" }))).toBe(rows);
    expect(reconcileList(rows, () => null)).toBe(rows);
  });

  it("is order- and length-preserving", () => {
    const next = reconcileList(rows, (r) => (r.id === "a" ? { stage: "x" } : null));
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the entrance stagger is bounded", () => {
  it("caps so a long list does not animate for seconds", () => {
    // 20 cards x 60ms = the last one STARTED 1.14s in and finished at 2.34s,
    // while the traveller was already trying to scroll.
    expect(staggerIndex(0)).toBe(0);
    expect(staggerIndex(3)).toBe(3);
    expect(staggerIndex(19)).toBe(MAX_STAGGER_INDEX);
    expect(MAX_STAGGER_INDEX * 60).toBeLessThanOrEqual(400);
  });

  it("is safe on junk input", () => {
    expect(staggerIndex(-4)).toBe(0);
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

describe("the boundary is actually in the list", () => {
  const page = readCode("src/app/page.tsx");

  it("the poll reconciles instead of rebuilding every shop", () => {
    expect(page).toMatch(/reconcileList\(vs/);
    expect(page).not.toMatch(/vs\.map\(\(v\) => \(v\.id === id \? \{ \.\.\.v, \.\.\.patch \} : v\)\)/);
  });

  it("card handlers are created ONCE, not per render", () => {
    // `onBook={pickVendorOption(setBookingVendor)}` built a new closure every
    // render and handed it to a memo'd card - the memo could never hold.
    expect(page).toMatch(/const onBookVendor = useCallbackRef/);
    expect(page).toMatch(/onBook=\{onBookVendor\}/);
    expect(page).not.toMatch(/onBook=\{pickVendorOption\(/);
    expect(page).not.toMatch(/onBargain=\{pickVendorOption\(/);
  });

  it("the stagger is capped in the render", () => {
    expect(page).toMatch(/staggerIndex\(i\)/);
  });

  it("will-change is scoped to interaction, not left on every card", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const start = css.indexOf(".lift {");
    const lift = css.slice(start, css.indexOf("}", start) + 1);
    // The base rule promoted EVERY card to its own compositor layer, always on.
    expect(lift).not.toMatch(/will-change/);
    // The hint belongs on the element that is about to move.
    expect(css).toMatch(/\.lift:active \{ will-change: transform; \}/);
  });
});
