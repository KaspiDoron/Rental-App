import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// THE FIRST TESTS THAT ACTUALLY RUN A ROUTE.
//
// All 122 API route handlers were verified only by regex over their own source
// text. That is not a small caveat - it is why several Wave 1 fixes could only
// be source-pinned, and it is how a route could `return NextResponse.json({...})`
// with a field the client never reads, or check a condition that can never be
// true, and pass a green suite forever.
//
// A source pin asserts that a line LOOKS right. These assert what the handler
// RETURNS, for a given input, with its collaborators stubbed. Start where Wave 1
// changed behaviour and a mistake costs money or access:
//
//   /api/billing/confirm - a plan grant that did not persist must not be
//                          reported as applied (M5)
//
// The pattern is deliberately plain - vi.mock the module boundary, call the
// exported POST/GET with a real Request, read the real Response - so the next
// route is a copy-paste rather than a design exercise.

const jsonRequest = (body: unknown) =>
  new Request("http://localhost/api/billing/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Load the route with its collaborators stubbed to the given behaviour. */
async function loadConfirm(opts: {
  session?: { email: string; plan?: string } | null;
  isTestUser?: boolean;
  granted?: boolean;
}) {
  vi.resetModules();
  const events: Array<Record<string, unknown>> = [];

  vi.doMock("@/lib/session", () => ({
    getSession: async () => (opts.session === undefined ? { email: "t@example.com" } : opts.session),
  }));
  vi.doMock("@/lib/allowlist", () => ({
    isTestUser: async () => opts.isTestUser ?? true,
  }));
  vi.doMock("@/lib/access", () => ({
    setPlan: async () => opts.granted ?? true,
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbInsert: async (_t: string, rows: Array<Record<string, unknown>>) => {
      events.push(...rows);
      return true;
    },
  }));

  const mod = await import("./billing/confirm/route");
  return { POST: mod.POST, events };
}

describe("POST /api/billing/confirm - executed, not pinned", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("refuses an unauthenticated caller", async () => {
    const { POST } = await loadConfirm({ session: null });
    const res = await POST(jsonRequest({ plan: "ultra" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in first." });
  });

  it("refuses a plan it does not sell", async () => {
    const { POST } = await loadConfirm({});
    const res = await POST(jsonRequest({ plan: "platinum" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown plan" });
  });

  it("...and a missing body is not a free upgrade", async () => {
    // The route is reachable by ANY signed-in user, so a malformed request must
    // fall out at the plan check rather than anywhere later.
    const { POST } = await loadConfirm({});
    const res = await POST(
      new Request("http://localhost/api/billing/confirm", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(400);
  });

  it("applies the sandbox plan for a flagged tester and says which", async () => {
    const { POST, events } = await loadConfirm({ isTestUser: true, granted: true });
    const res = await POST(jsonRequest({ plan: "ultra" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sandbox: true, applied: "ultra" });
    expect(events[0]).toMatchObject({ type: "plan_activated_ultra_sandbox", verified: false });
  });

  it("REPRODUCTION: a grant that did NOT persist is not reported as applied", async () => {
    // setPlan used to return void, so a failed write to app_users answered
    // ok:true - the tester was shown Ultra features they did not have. This is
    // the assertion a source pin could not make: it reads the actual response.
    const { POST, events } = await loadConfirm({ isTestUser: true, granted: false });
    const res = await POST(jsonRequest({ plan: "ultra" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/could not apply the plan/i);
    // ...and the failure leaves a trace the owner can find.
    expect(events[0]).toMatchObject({ type: "plan_grant_failed_ultra_sandbox" });
  });

  it("maps 'business' to ultra rather than inventing a tier", async () => {
    const { POST } = await loadConfirm({ isTestUser: true, granted: true });
    const res = await POST(jsonRequest({ plan: "business" }));
    expect((await res.json()).applied).toBe("ultra");
  });

  it("a NON-tester never gets an instant grant from this endpoint", async () => {
    // The security property the file's own header states: this route is
    // reachable by any signed-in user and must never grant on its own say-so.
    // Without a subscriptionId there is nothing to verify, so it must not
    // answer `applied`.
    const { POST } = await loadConfirm({ isTestUser: false, granted: true });
    const res = await POST(jsonRequest({ plan: "ultra" }));
    const body = await res.json();
    expect(body.applied).toBeUndefined();
    expect(body.sandbox).toBeUndefined();
  });
});
