import { describe, it, expect, beforeEach, vi } from "vitest";

// A tiny in-memory Redis stand-in exercising only the commands the buffer uses.
const { fake, reset } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const fake = {
    async set(key: string, val: string, _ex?: string, _sec?: number, nx?: string) {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, val);
      return "OK";
    },
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async rpush(key: string, val: string) {
      const a = lists.get(key) ?? [];
      a.push(val);
      lists.set(key, a);
      return a.length;
    },
    async expire() {
      return 1;
    },
    async lrange(key: string) {
      return lists.get(key) ?? [];
    },
    async del(key: string) {
      store.delete(key);
      lists.delete(key);
      return 1;
    },
  };
  return {
    fake,
    reset: () => {
      store.clear();
      lists.clear();
    },
  };
});

vi.mock("./index", () => ({ redis: () => fake }));

import {
  beginImageWindow,
  drainImageWindow,
  imageWindowKey,
  imageBufferKey,
} from "./image-buffer";

beforeEach(() => reset());

describe("image-buffer key schema", () => {
  it("scopes the window by (receiver, from) and the buffer by leader id", () => {
    expect(imageWindowKey("me@x.com", "66123")).toBe("imgwin:me@x.com:66123");
    expect(imageBufferKey("MSG1")).toBe("imgbuf:MSG1");
  });
});

describe("multi-image coalescing (Module 4.1)", () => {
  it("first frame leads; siblings in the same burst do NOT re-lead but ARE buffered", async () => {
    const base = { receiver: "me@x.com", from: "66123", frame: { k: 1 } };
    const a = await beginImageWindow({ ...base, waMessageId: "A", frame: { n: 1 } });
    const b = await beginImageWindow({ ...base, waMessageId: "B", frame: { n: 2 } });
    const c = await beginImageWindow({ ...base, waMessageId: "C", frame: { n: 3 } });

    expect(a.first).toBe(true);
    expect(a.leaderWaId).toBe("A");
    expect(b.first).toBe(false);
    expect(b.leaderWaId).toBe("A"); // siblings inherit the leader
    expect(c.first).toBe(false);

    // The leader's child drains ALL three frames, in arrival order.
    const frames = await drainImageWindow({ receiver: "me@x.com", from: "66123", leaderWaId: "A" });
    expect(frames).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("a different (receiver, from) gets its own independent leader + buffer", async () => {
    const a = await beginImageWindow({
      receiver: "me@x.com",
      from: "111",
      waMessageId: "A",
      frame: { n: 1 },
    });
    const b = await beginImageWindow({
      receiver: "me@x.com",
      from: "222",
      waMessageId: "B",
      frame: { n: 2 },
    });
    expect(a.first).toBe(true);
    expect(b.first).toBe(true); // different shop -> its own window
    expect(b.leaderWaId).toBe("B");
  });

  it("draining clears the buffer so a following burst starts clean", async () => {
    await beginImageWindow({ receiver: "r", from: "f", waMessageId: "A", frame: { n: 1 } });
    const first = await drainImageWindow({ receiver: "r", from: "f", leaderWaId: "A" });
    expect(first).toEqual([{ n: 1 }]);
    // Second drain of the same leader is empty (already consumed).
    const second = await drainImageWindow({ receiver: "r", from: "f", leaderWaId: "A" });
    expect(second).toEqual([]);
    // And the window claim was released, so a new frame leads a fresh burst.
    const next = await beginImageWindow({ receiver: "r", from: "f", waMessageId: "Z", frame: { n: 9 } });
    expect(next.first).toBe(true);
    expect(next.leaderWaId).toBe("Z");
  });
});
