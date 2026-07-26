import { describe, it, expect, vi, afterEach } from "vitest";
import { probeWaStatus } from "./wa-status";

// The bug this file exists for: a traveller whose WhatsApp WAS connected saw
// "Link WhatsApp to unlock the search" over their search form, because a single
// un-retried status fetch failed and the caller recorded that failure as a
// confirmed "not linked". These tests pin the distinction that fixes it.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn((url: unknown, init?: RequestInit) =>
    Promise.resolve(impl(String(url), init))
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("probeWaStatus - a failed read is not an answer", () => {
  it("reports connected when the server says so", async () => {
    mockFetch(() => ok({ available: true, connected: true, live: true }));
    const s = await probeWaStatus({ attempts: 1 });
    expect(s).toMatchObject({ reachable: true, connected: true, live: true });
  });

  it("reports a CONFIRMED unlink - the only case that may draw the lock", async () => {
    mockFetch(() => ok({ available: true, connected: false }));
    const s = await probeWaStatus({ attempts: 1 });
    expect(s.reachable).toBe(true);
    expect(s.connected).toBe(false);
  });

  it("a network failure is unreachable, NOT 'not linked'", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    const s = await probeWaStatus({ attempts: 1 });
    expect(s.reachable).toBe(false);
  });

  it("a 500 is unreachable too - an error page is not a verdict", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    expect((await probeWaStatus({ attempts: 1 })).reachable).toBe(false);
  });

  it("a body without a boolean `connected` is unreachable, never a false", async () => {
    // e.g. an HTML error page, or the 401 { error } shape.
    mockFetch(() => ok({ error: "Sign in first." }));
    const s = await probeWaStatus({ attempts: 1 });
    expect(s.reachable).toBe(false);
    // Callers read `reachable` first; `connected` must never be trusted here.
    expect(s.connected).toBe(false);
  });

  it("retries a transient failure and takes the later answer", async () => {
    let n = 0;
    mockFetch(() => {
      n++;
      if (n === 1) throw new Error("cold host");
      return ok({ available: true, connected: true });
    });
    const s = await probeWaStatus({ attempts: 2 });
    expect(n).toBe(2);
    expect(s).toMatchObject({ reachable: true, connected: true });
  });

  it("stops at the first real answer - a confirmed false is not retried away", async () => {
    const spy = mockFetch(() => ok({ available: true, connected: false }));
    await probeWaStatus({ attempts: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("probeWaStatus - never served from a cache", () => {
  it("sends no-store and a cache-buster on every request", async () => {
    const spy = mockFetch(() => ok({ available: true, connected: true }));
    await probeWaStatus({ attempts: 1 });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    // A stale "connected:false" replayed by the browser is indistinguishable
    // from a real disconnection - which is exactly how this bug presented.
    expect(init.cache).toBe("no-store");
    expect(url).toMatch(/[?&]t=\d+/);
  });

  it("passes pairing=1 only when asked (it skips the server-side drains)", async () => {
    const spy = mockFetch(() => ok({ available: true, connected: true }));
    await probeWaStatus({ attempts: 1 });
    expect(String(spy.mock.calls[0][0])).not.toContain("pairing=1");
    await probeWaStatus({ pairing: true, attempts: 1 });
    expect(String(spy.mock.calls[1][0])).toContain("pairing=1");
  });

  it("bounds each attempt with an abort signal", async () => {
    const spy = mockFetch(() => ok({ available: true, connected: true }));
    await probeWaStatus({ attempts: 1 });
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
