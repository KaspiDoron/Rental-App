import { describe, it, expect, afterEach, vi } from "vitest";
import { probeAuthMethods, AUTH_METHODS_TIMEOUT_MS } from "./useAuthMethods";
import { alternateMethods, buildAuthMethods, primaryMethod } from "../../lib/auth/methods";

// WHY THIS FILE EXISTS
//
// The old provider probe was a bare `fetch("/api/config/public")` with no
// timeout and no loading state, in front of a force-dynamic endpoint whose first
// call on a cold instance is a Supabase round trip. While it was in flight the
// sign-in area rendered a divider above an empty gap; if it stalled it rendered
// that forever. The invariant these tests pin is simple and total: the probe
// always reaches a terminal state, and its degraded answer is a working
// email-only list with a reason - never blankness.

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof globalThis.fetch;
}

describe("the probe always lands somewhere", () => {
  it("a healthy answer is ready, with the alternates the server declared", async () => {
    globalThis.fetch = respond(200, {
      methods: buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" }),
    });
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("ready");
    expect(alternateMethods(probe.methods).map((m) => m.id)).toEqual(["google"]);
    expect(probe.error).toBeUndefined();
  });

  it("a server with no Google key is READY with zero alternates, not failed", async () => {
    // The no-provider deployment is a healthy deployment. Reporting it as a
    // failure would put an error where a plain email form belongs.
    globalThis.fetch = respond(200, { methods: buildAuthMethods({ sessionReady: true }) });
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("ready");
    expect(alternateMethods(probe.methods)).toEqual([]);
    expect(primaryMethod(probe.methods).ready).toBe(true);
  });

  it("a request that never answers ends as failed, never as probing", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as typeof globalThis.fetch;

    const p = probeAuthMethods();
    await vi.advanceTimersByTimeAsync(AUTH_METHODS_TIMEOUT_MS);
    const probe = await p;
    expect(probe.state).toBe("failed");
    expect(probe.error?.length).toBeGreaterThan(0);
    // ...and email still works, which is the whole point of degrading.
    expect(primaryMethod(probe.methods).ready).toBe(true);
    expect(alternateMethods(probe.methods)).toEqual([]);
  });

  it("a 500 degrades the same way and surfaces something to read", async () => {
    globalThis.fetch = respond(500, { error: "boom" });
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("failed");
    expect(probe.error?.length).toBeGreaterThan(0);
    expect(primaryMethod(probe.methods).ready).toBe(true);
  });

  it("a transport failure degrades rather than rejecting", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("failed");
    expect(alternateMethods(probe.methods)).toEqual([]);
  });

  it("a 200 carrying a payload we cannot trust is a failure, not an empty success", async () => {
    globalThis.fetch = respond(200, { methods: "not-a-list" });
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("failed");
    expect(probe.error?.length).toBeGreaterThan(0);
  });

  it("never returns the probing state - it is an initial value, not an outcome", async () => {
    globalThis.fetch = respond(200, {
      methods: buildAuthMethods({ sessionReady: true, googleClientId: "abc.apps" }),
    });
    for (const status of [200, 401, 500]) {
      globalThis.fetch = respond(status, { methods: [] });
      expect((await probeAuthMethods()).state).not.toBe("probing");
    }
  });

  it("an unauthorized-looking Google entry is dropped client-side too", async () => {
    // Belt and braces: the server said ready but shipped no client ID, so the
    // button could not render and the divider must not either.
    globalThis.fetch = respond(200, {
      methods: [
        { id: "email", kind: "credential", label: "Email", ready: true },
        { id: "google", kind: "oauth", label: "Google", ready: true },
      ],
    });
    const probe = await probeAuthMethods();
    expect(probe.state).toBe("ready");
    expect(alternateMethods(probe.methods)).toEqual([]);
  });
});
