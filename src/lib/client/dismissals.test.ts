import { describe, it, expect } from "vitest";
import { dismissalKey, loadDismissals, saveDismissals, type DismissalStore } from "./dismissals";

// The regression this pins: DISMISS "did nothing" because the acknowledgement
// lived in a bare useState Set while the vendors it acknowledged were restored
// from sessionStorage on every TabBar hop (a full document navigation).

const memStore = (): DismissalStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

describe("dismissals - acknowledgements survive a remount", () => {
  it("round-trips through the store", () => {
    const store = memStore();
    const keys = new Set([dismissalKey("v1", "2026-07-29T11:16:00Z"), dismissalKey("v2", null)]);
    saveDismissals(store, keys);
    expect(loadDismissals(store)).toEqual(keys);
  });

  it("a LATER removal of the same shop is a new fact - its key differs", () => {
    const first = dismissalKey("v1", "2026-07-29T11:16:00Z");
    const later = dismissalKey("v1", "2026-07-30T09:00:00Z");
    expect(first).not.toBe(later);
    const dismissed = new Set([first]);
    expect(dismissed.has(later)).toBe(false); // the notice reappears
  });

  it("no store / corrupt store degrade to an empty set, never a throw", () => {
    expect(loadDismissals(null).size).toBe(0);
    const store = memStore();
    store.data.set("wd_removed_dismissed", "{not json");
    expect(loadDismissals(store).size).toBe(0);
    expect(() => saveDismissals(null, new Set(["x"]))).not.toThrow();
  });

  it("is bounded - the newest 200 acknowledgements win", () => {
    const store = memStore();
    const keys = new Set<string>();
    for (let i = 0; i < 250; i++) keys.add(dismissalKey(`v${i}`, null));
    saveDismissals(store, keys);
    const loaded = loadDismissals(store);
    expect(loaded.size).toBe(200);
    expect(loaded.has(dismissalKey("v249", null))).toBe(true);
    expect(loaded.has(dismissalKey("v0", null))).toBe(false);
  });
});
