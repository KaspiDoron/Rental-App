import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchJson } from "./fetch-json";

// WHY THIS FILE EXISTS
//
// Browsers put no timeout on `fetch`, so a request that is accepted and then
// stalled never resolves AND never rejects - the caller's catch block is simply
// never reached and the UI has no event to react to. That is how a login screen
// ends up showing an empty gap forever. These tests pin the property that makes
// that unrepresentable: this helper always settles, and it says WHICH way it
// failed so the copy can be honest.

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/** A fetch that hangs until the signal aborts - the stalled-connection case. */
function stallingFetch(): typeof globalThis.fetch {
  const abortError = () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  };
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      // Real fetch checks `aborted` synchronously before it ever listens.
      if (init?.signal?.aborted) return reject(abortError());
      init?.signal?.addEventListener("abort", () => reject(abortError()));
    })) as typeof globalThis.fetch;
}

function jsonFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("a request that stalls still produces an answer", () => {
  it("reports timedOut at the deadline with copy to show", async () => {
    vi.useFakeTimers();
    globalThis.fetch = stallingFetch();
    const p = fetchJson("/api/anything", { timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.error?.length).toBeGreaterThan(0);
    expect(res.status).toBe(0);
  });

  it("never throws - the caller pattern-matches instead of writing try/catch", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    const res = await fetchJson("/api/anything");
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBeUndefined();
    expect(res.error?.length).toBeGreaterThan(0);
  });

  it("a caller's own abort is reported as abandoned, not as an error to show", async () => {
    globalThis.fetch = stallingFetch();
    const ctrl = new AbortController();
    const p = fetchJson("/api/anything", { signal: ctrl.signal, timeoutMs: 60_000 });
    ctrl.abort();
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it("a signal that is already aborted short-circuits", async () => {
    globalThis.fetch = stallingFetch();
    const res = await fetchJson("/api/anything", { signal: AbortSignal.abort() });
    expect(res.aborted).toBe(true);
  });
});

describe("the body survives the status", () => {
  it("returns parsed JSON on success", async () => {
    globalThis.fetch = jsonFetch(200, { methods: [1, 2] });
    const res = await fetchJson<{ methods: number[] }>("/api/x");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data?.methods).toEqual([1, 2]);
  });

  it("keeps the body of an ERROR response - the API answers errors in JSON", async () => {
    // /api/auth/login answers 400 with { error, needsSignup }; throwing that
    // away would discard the only useful information in the failure.
    globalThis.fetch = jsonFetch(400, { error: "Enter a valid email.", needsSignup: true });
    const res = await fetchJson<{ error: string; needsSignup: boolean }>("/api/auth/login");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.data?.needsSignup).toBe(true);
    expect(res.error).toBe("Enter a valid email.");
  });

  it("falls back to status-shaped copy when the error body has no message", async () => {
    globalThis.fetch = jsonFetch(500, {});
    const a = await fetchJson("/api/x");
    expect(a.error?.length).toBeGreaterThan(0);

    globalThis.fetch = jsonFetch(429, {});
    const b = await fetchJson("/api/x");
    expect(b.error).toMatch(/wait/i);
  });

  it("a non-JSON body is not a crash", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>gateway</html>", { status: 502 })) as typeof globalThis.fetch;
    const res = await fetchJson("/api/x");
    expect(res.ok).toBe(false);
    expect(res.data).toBeUndefined();
    expect(res.error?.length).toBeGreaterThan(0);
  });

  it("an empty 204 body is a success with no data", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof globalThis.fetch;
    const res = await fetchJson("/api/x");
    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });
});

describe("the deadline covers the body, not just the headers", () => {
  it("a response whose body never arrives still times out", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      } as unknown as Response)) as typeof globalThis.fetch;

    const p = fetchJson("/api/x", { timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    // The body read shares the signal, so the abort surfaces rather than the
    // request sitting on undici's ~300s default bodyTimeout.
    expect(res.ok).toBe(false);
  });
});
