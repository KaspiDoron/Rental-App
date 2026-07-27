import { describe, it, expect } from "vitest";
import {
  MAX_PERSISTED_VENDORS,
  loadSearch,
  saveSearch,
  snapshotLadder,
  type StorageLike,
} from "./search-persist";

/** A storage that refuses anything over `limit` bytes, like a real quota. */
function boundedStore(limit: number): StorageLike & { value: string | null } {
  return {
    value: null as string | null,
    getItem(k: string) {
      void k;
      return this.value;
    },
    setItem(k: string, v: string) {
      void k;
      if ((this.value?.length ?? 0) + v.length > limit) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      this.value = v;
    },
    removeItem(k: string) {
      void k;
      this.value = null;
    },
  };
}

const vendor = (i: number) => ({
  id: `v${i}`,
  name: `Shop ${i}`,
  stage: "awaiting-response",
  offer: { pricePerDay: 250, currency: "THB" },
  photoUrls: Array.from({ length: 10 }, () => "x".repeat(400)),
  sentText: "y".repeat(1200),
  options: [{ label: "z".repeat(600) }],
});

const search = (n: number) => ({ vendors: Array.from({ length: n }, (_, i) => vendor(i)), rfq: {} });

describe("shedding weight without losing the search", () => {
  it("every rung keeps identity, stage and offer", () => {
    for (const rung of snapshotLadder(search(3))) {
      for (const v of rung.vendors as Record<string, unknown>[]) {
        expect(v.id).toBeTruthy();
        expect(v.name).toBeTruthy();
        expect(v.stage).toBeTruthy();
        expect(v.offer).toBeTruthy();
      }
    }
  });

  it("sheds the gallery first, the message bodies next", () => {
    const [full, noPhotos, noText] = snapshotLadder(search(2));
    expect((full.vendors[0] as Record<string, unknown>).photoUrls).toBeTruthy();
    expect((noPhotos.vendors[0] as Record<string, unknown>).photoUrls).toBeUndefined();
    expect((noPhotos.vendors[0] as Record<string, unknown>).sentText).toBeTruthy();
    expect((noText.vendors[0] as Record<string, unknown>).sentText).toBeUndefined();
  });

  it("caps the shop list only when there are more than the cap", () => {
    expect(snapshotLadder(search(3)).length).toBe(4); // full + 3 shed rungs
    const many = snapshotLadder(search(MAX_PERSISTED_VENDORS + 5));
    expect((many[many.length - 1].vendors as unknown[]).length).toBe(MAX_PERSISTED_VENDORS);
  });
});

describe("the write lands, or says it did not", () => {
  it("a roomy device stores the full snapshot", () => {
    const store = boundedStore(10_000_000);
    const res = saveSearch(store, "wd_search", search(12));
    expect(res.ok).toBe(true);
    expect(res.rung).toBe(0);
  });

  it("a tight quota still stores a USABLE search, just lighter", () => {
    // This is the live failure: a busy hunt, a full blob, `setItem` throws, and
    // the old empty catch turned that into a traveller returning to a blank
    // page.
    const store = boundedStore(6_000);
    const res = saveSearch(store, "wd_search", search(12));
    expect(res.ok).toBe(true);
    expect(res.rung).toBeGreaterThan(0);

    const back = loadSearch(store, "wd_search");
    expect(back).toBeTruthy();
    expect((back!.vendors[0] as Record<string, unknown>).id).toBe("v0");
    expect((back!.vendors[0] as Record<string, unknown>).offer).toBeTruthy();
  });

  it("an impossible quota REPORTS the failure instead of swallowing it", () => {
    const res = saveSearch(boundedStore(10), "wd_search", search(12));
    expect(res.ok).toBe(false);
  });

  it("never throws, whatever the storage does", () => {
    const hostile: StorageLike = {
      getItem() {
        throw new Error("nope");
      },
      setItem() {
        throw new Error("nope");
      },
      removeItem() {
        throw new Error("nope");
      },
    };
    expect(() => saveSearch(hostile, "k", search(2))).not.toThrow();
    expect(() => loadSearch(hostile, "k")).not.toThrow();
    expect(loadSearch(hostile, "k")).toBeNull();
    expect(saveSearch(undefined, "k", search(1)).ok).toBe(false);
  });

  it("garbage in storage restores as nothing, not as a crash", () => {
    const store = boundedStore(1000);
    store.value = "{not json";
    expect(loadSearch(store, "wd_search")).toBeNull();
    store.value = JSON.stringify({ vendors: "nope" });
    expect(loadSearch(store, "wd_search")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

describe("the funnel persists through the budget", () => {
  it("page.tsx saves with the ladder and no longer writes blind", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toMatch(/saveSearch\(sessionStorage, "wd_search"/);
    expect(page).not.toMatch(/sessionStorage\.setItem\(\s*"wd_search"/);
  });

  it("a lost session is told to the traveller", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(page).toMatch(/if \(!res\.ok\)/);
  });
});
