import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// WAVE 4.3 - the PayPal webhook doctor, the 503-when-unconfigured webhook
// route, the key-test fail-green fix, and the reconcile sweep's fail
// direction. Route handlers execute for real via vi.doMock + relative
// imports (the admin-workspace.test.ts pattern).

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/runtime-config");
  vi.doUnmock("@/lib/paypal");
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/site");
  vi.doUnmock("@/lib/access");
  vi.doUnmock("@/lib/billing/subscription-link");
});

describe("PAYPAL_WEBHOOK_EVENTS drift", () => {
  it("covers every event literal the webhook route + suspension logic branch on", async () => {
    const { PAYPAL_WEBHOOK_EVENTS } = await import("../paypal");
    const sources =
      read("src/app/api/webhooks/paypal/route.ts") + read("src/lib/billing/suspension.ts");
    const literals = new Set(
      [...sources.matchAll(/"((?:BILLING|PAYMENT)\.[A-Z._-]+)"/g)].map((m) => m[1])
    );
    expect(literals.size).toBeGreaterThan(0);
    for (const lit of literals) {
      expect(
        PAYPAL_WEBHOOK_EVENTS,
        `${lit} is branched on but NOT in the webhook subscription - PayPal would never send it`
      ).toContain(lit);
    }
    // And nothing subscribed that no code branches on (a silent event is
    // billing noise that LOOKS load-bearing).
    for (const evt of PAYPAL_WEBHOOK_EVENTS) {
      expect(literals, `${evt} is subscribed but nothing handles it`).toContain(evt);
    }
  });
});

describe("webhook route without PAYPAL_WEBHOOK_ID", () => {
  beforeEach(() => vi.resetModules());

  it("answers 503 (so PayPal RETRIES) and records the knock - never a swallowing 200", async () => {
    const inserted: { table: string; rows: unknown[] }[] = [];
    vi.doMock("@/lib/runtime-config", () => ({
      getConfig: vi.fn(async () => null),
      sbInsert: vi.fn(async (table: string, rows: unknown[]) => {
        inserted.push({ table, rows });
        return true;
      }),
    }));
    vi.doMock("@/lib/paypal", () => ({
      verifyPaypalWebhook: vi.fn(async () => false),
      tierForPaypalPlan: vi.fn(async () => null),
      fetchPaypalSubscription: vi.fn(async () => null),
    }));
    vi.doMock("@/lib/access", () => ({ setPlan: vi.fn(async () => true) }));
    const route = await import("../../app/api/webhooks/paypal/route");
    const res = await route.POST(
      new Request("http://x/api/webhooks/paypal", {
        method: "POST",
        body: JSON.stringify({
          id: "WH-1",
          event_type: "BILLING.SUBSCRIPTION.CANCELLED",
          resource: { id: "I-123" },
        }),
      })
    );
    expect(res.status).toBe(503);
    const rows = inserted.flatMap((i) => i.rows) as { type?: string }[];
    expect(rows.some((r) => String(r.type).startsWith("pp_unconfigured_"))).toBe(true);
  });
});

describe("paypal-doctor connect", () => {
  beforeEach(() => vi.resetModules());

  function mockCommon(over: {
    hooks?: { id: string; url: string; eventTypes: string[] }[] | null;
    origin?: string;
    created?: { id?: string; error?: string };
    setConfigOk?: boolean;
  }) {
    const calls = {
      setConfig: [] as [string, string][],
      created: [] as string[],
      patched: [] as string[],
    };
    vi.doMock("@/lib/session", () => ({
      requireManagement: vi.fn(async () => ({ email: "admin@e2e.test", isAdmin: true })),
    }));
    vi.doMock("@/lib/site", () => ({
      resolveSiteOrigin: vi.fn(async () => over.origin ?? "https://wheeldeal.pro"),
    }));
    let listCount = 0;
    vi.doMock("@/lib/paypal", async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return {
        ...real,
        paypalConfigured: vi.fn(async () => true),
        listPaypalWebhooks: vi.fn(async () => {
          listCount++;
          // After a create/patch the re-list verify sees the repaired state.
          if (listCount > 1 && over.hooks !== null) {
            return [
              {
                id: over.created?.id ?? over.hooks?.[0]?.id ?? "WH-NEW",
                url: `${over.origin ?? "https://wheeldeal.pro"}/api/webhooks/paypal`,
                eventTypes: [...(real.PAYPAL_WEBHOOK_EVENTS as string[])],
              },
            ];
          }
          // null means UNREADABLE and must stay null - `?? []` would silently
          // turn the outage case into the absent case.
          return over.hooks === null ? null : (over.hooks ?? []);
        }),
        createPaypalWebhook: vi.fn(async (url: string) => {
          calls.created.push(url);
          return over.created ?? { id: "WH-NEW" };
        }),
        patchPaypalWebhook: vi.fn(async (id: string) => {
          calls.patched.push(id);
          return true;
        }),
      };
    });
    vi.doMock("@/lib/runtime-config", () => ({
      getConfig: vi.fn(async (k: string) => (k === "PAYPAL_WEBHOOK_ID" ? "WH-NEW" : null)),
      setConfig: vi.fn(async (k: string, v: string) => {
        calls.setConfig.push([k, v]);
        return { ok: over.setConfigOk !== false, persistent: true };
      }),
    }));
    return calls;
  }

  it("absent -> creates the webhook, stores the id in the vault, re-verifies", async () => {
    const calls = mockCommon({ hooks: [] });
    const route = await import("../../app/api/admin/paypal-doctor/route");
    const res = await route.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "connect" }) })
    );
    const d = await res.json();
    expect(calls.created.length).toBe(1);
    expect(calls.created[0]).toBe("https://wheeldeal.pro/api/webhooks/paypal");
    expect(calls.setConfig).toContainEqual(["PAYPAL_WEBHOOK_ID", "WH-NEW"]);
    expect(d.ok).toBe(true);
    expect(d.state).toBe("verified");
  });

  it("refuses a non-https origin by name instead of registering a webhook PayPal will reject", async () => {
    const calls = mockCommon({ hooks: [], origin: "http://0.0.0.0:8080" });
    const route = await import("../../app/api/admin/paypal-doctor/route");
    const res = await route.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "connect" }) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/);
    expect(calls.created.length).toBe(0);
  });

  it("unreadable list -> 502, never a blind create", async () => {
    const calls = mockCommon({ hooks: null });
    const route = await import("../../app/api/admin/paypal-doctor/route");
    const res = await route.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ action: "connect" }) })
    );
    expect(res.status).toBe(502);
    expect(calls.created.length).toBe(0);
  });

  it("NEVER deletes a webhook (source pin - repair is patch-or-create only)", () => {
    const src = read("src/app/api/admin/paypal-doctor/route.ts");
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(read("src/lib/paypal.ts")).not.toMatch(/method:\s*"DELETE"/);
  });

  it("the webhook URL comes from resolveSiteOrigin, never from request headers", () => {
    const src = read("src/app/api/admin/paypal-doctor/route.ts");
    expect(src).toMatch(/resolveSiteOrigin\(\)/);
    expect(src).not.toMatch(/req\.headers|headers\(\)\.get|x-forwarded/i);
  });
});

describe("key-test fail-green fix", () => {
  it("an EMPTY webhook list fails the check instead of skipping it (source pin)", () => {
    const src = read("src/app/api/admin/key-test/route.ts");
    // The old guard (length-gated includes) waved through an app with no
    // webhooks at all. The `if (`-anchored form matches only CODE - the
    // explanatory comment quotes the old guard without it.
    expect(src).not.toMatch(/if \(ids\.length && !ids\.includes/);
    expect(src).toMatch(/if \(readable && !ids\.includes/);
    expect(src).toMatch(/NO webhooks at all/);
  });
});

describe("reconcile sweep fail direction", () => {
  beforeEach(() => vi.resetModules());

  function mockReconcile(opts: {
    subs: Record<string, { status: string } | null>;
    activations: Record<string, string[]>;
  }) {
    const downgrades: [string, string][] = [];
    vi.doMock("@/lib/access", () => ({
      listUsers: vi.fn(async () => [
        { email: "paid@x.com", plan: "pro" },
        { email: "free@x.com", plan: "free" },
      ]),
      setPlan: vi.fn(async (email: string, plan: string) => {
        downgrades.push([email, plan]);
        return true;
      }),
    }));
    vi.doMock("@/lib/billing/subscription-link", () => ({
      activationsFor: vi.fn(async (email: string) => opts.activations[email] ?? []),
    }));
    vi.doMock("@/lib/paypal", () => ({
      paypalConfigured: vi.fn(async () => true),
      fetchPaypalSubscription: vi.fn(async (id: string) => opts.subs[id] ?? null),
      subscriptionEntitles: (s: string) => ["ACTIVE", "APPROVED"].includes(s.toUpperCase()),
    }));
    vi.doMock("@/lib/runtime-config", () => ({ sbInsert: vi.fn(async () => true) }));
    return downgrades;
  }

  it("downgrades a paid plan whose only subscription PayPal says is CANCELLED", async () => {
    const downgrades = mockReconcile({
      activations: { "paid@x.com": ["I-1"] },
      subs: { "I-1": { status: "CANCELLED" } },
    });
    const { reconcilePaypalPlans } = await import("./reconcile");
    const out = await reconcilePaypalPlans();
    expect(downgrades).toEqual([["paid@x.com", "free"]]);
    expect(out.downgraded).toEqual(["paid@x.com"]);
  });

  it("an UNREADABLE subscription changes nothing - never downgrade on a shrug", async () => {
    const downgrades = mockReconcile({
      activations: { "paid@x.com": ["I-1"] },
      subs: { "I-1": null },
    });
    const { reconcilePaypalPlans } = await import("./reconcile");
    const out = await reconcilePaypalPlans();
    expect(downgrades).toEqual([]);
    expect(out.unknown).toBe(1);
  });

  it("a SUSPENDED subscription is the grace window's job - kept", async () => {
    const downgrades = mockReconcile({
      activations: { "paid@x.com": ["I-1"] },
      subs: { "I-1": { status: "SUSPENDED" } },
    });
    const { reconcilePaypalPlans } = await import("./reconcile");
    await reconcilePaypalPlans();
    expect(downgrades).toEqual([]);
  });

  it("no recorded activation (owner-granted / TEST_MODE plan) is not ours to judge", async () => {
    const downgrades = mockReconcile({ activations: {}, subs: {} });
    const { reconcilePaypalPlans } = await import("./reconcile");
    const out = await reconcilePaypalPlans();
    expect(downgrades).toEqual([]);
    expect(out.unknown).toBe(1);
  });
});
