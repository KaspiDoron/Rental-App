import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GsiLoadError, gsiButtonWidth, loadGsi, resetGsi, GSI_SRC } from "./gsi";

// WHY THIS FILE EXISTS
//
// The inline loader this replaced never settled when accounts.google.com was
// accepted-then-dropped (captive portal, blocked region, proxy black hole).
// Because the login page awaited it, everything after the await - including the
// only code that could have told the user anything - was never scheduled. So the
// two properties worth pinning are: it ALWAYS settles, and it never appends a
// second <script> no matter how many mounts race.

interface FakeScript {
  src: string;
  async?: boolean;
  defer?: boolean;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

let appended: FakeScript[] = [];

function makeScript(): FakeScript {
  return {
    src: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    fire(type) {
      for (const fn of [...(this.listeners[type] ?? [])]) fn();
    },
  };
}

function installFakeDom() {
  appended = [];
  (globalThis as Record<string, unknown>).document = {
    head: {
      appendChild(node: FakeScript) {
        appended.push(node);
        return node;
      },
    },
    createElement: () => makeScript(),
    // The loader reuses a tag another mount already added; the fake reports the
    // ones that were actually appended.
    querySelector: (sel: string) =>
      sel.includes(GSI_SRC) ? (appended.find((s) => s.src === GSI_SRC) ?? null) : null,
  };
}

function publishApi() {
  (globalThis as Record<string, unknown>).google = {
    accounts: { id: { initialize: () => {}, renderButton: () => {} } },
  };
}

beforeEach(() => {
  resetGsi();
  vi.useFakeTimers();
  installFakeDom();
  delete (globalThis as Record<string, unknown>).google;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).google;
  resetGsi();
});

describe("a provider script that never answers still settles", () => {
  it("rejects at the deadline instead of hanging forever", async () => {
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    // The tag was appended and simply never fires load or error - the exact
    // stalled-connection case the old code could not survive.
    expect(appended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    const err = await seen;
    expect(err).toBeInstanceOf(GsiLoadError);
    expect((err as GsiLoadError).code).toBe("script-timeout");
    expect((err as GsiLoadError).message.length).toBeGreaterThan(0);
  });

  it("resolves with the API when the script loads in time", async () => {
    const p = loadGsi(8000);
    publishApi();
    appended[0].fire("load");
    await expect(p).resolves.toHaveProperty("accounts.id");
  });

  it("a tag that loads but leaves no API behind is a failure, not a success", async () => {
    // A content blocker serving an empty 200 used to crash the caller on
    // `accounts.id.initialize` instead of showing a message.
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    appended[0].fire("load");
    const err = await seen;
    expect(err).toBeInstanceOf(GsiLoadError);
    expect((err as GsiLoadError).code).toBe("no-api");
  });

  it("a network error rejects immediately, before the deadline", async () => {
    const p = loadGsi(8000);
    const seen = p.catch((e) => e);
    appended[0].fire("error");
    const err = await seen;
    expect((err as GsiLoadError).code).toBe("script-error");
  });

  it("with no DOM at all it rejects rather than throwing synchronously", async () => {
    delete (globalThis as Record<string, unknown>).document;
    await expect(loadGsi(8000)).rejects.toBeInstanceOf(GsiLoadError);
  });
});

describe("one load, however many callers", () => {
  it("two concurrent mounts share one promise and one script tag", async () => {
    const a = loadGsi(8000);
    const b = loadGsi(8000);
    expect(a).toBe(b);
    expect(appended).toHaveLength(1);
    publishApi();
    appended[0].fire("load");
    await expect(a).resolves.toBeDefined();
    // A caller arriving after the API is live gets it without touching the DOM.
    await expect(loadGsi(8000)).resolves.toBeDefined();
    expect(appended).toHaveLength(1);
  });

  it("a remount after failure can retry - the rejection does not poison the memo", async () => {
    const first = loadGsi(8000);
    const failed = first.catch((e) => e);
    appended[0].fire("error");
    expect(await failed).toBeInstanceOf(GsiLoadError);

    const second = loadGsi(8000);
    expect(second).not.toBe(first);
    // It reuses the tag already in the document rather than piling up more.
    expect(appended).toHaveLength(1);
    publishApi();
    appended[0].fire("load");
    await expect(second).resolves.toBeDefined();
  });

  it("a timed-out load can still succeed on a later attempt", async () => {
    const first = loadGsi(1000);
    const failed = first.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failed).toBeInstanceOf(GsiLoadError);

    publishApi();
    await expect(loadGsi(1000)).resolves.toBeDefined();
  });
});

describe("the button width is measured, never assumed", () => {
  it("clamps into the range Google accepts", () => {
    expect(gsiButtonWidth(240)).toBe(240);
    expect(gsiButtonWidth(120)).toBe(200);
    expect(gsiButtonWidth(900)).toBe(400);
  });

  it("never returns a width that would overflow a 320px viewport's content box", () => {
    // 320 viewport - 40 (main px-5) - 40 (card p-5) = 240 of usable width. The
    // old literal 320 broke 40px out of the card on each side.
    const container = 240;
    expect(gsiButtonWidth(container)!).toBeLessThanOrEqual(container);
  });

  it("returns nothing when the container has not been measured yet", () => {
    expect(gsiButtonWidth(0)).toBeUndefined();
    expect(gsiButtonWidth(Number.NaN)).toBeUndefined();
  });
});
