import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// "Test AI providers" (owner request, post-launch): one tap fires a tiny real
// completion at EVERY configured provider and reports which MODEL answered.
// These tests execute the route for real (admin-workspace.test.ts pattern)
// and pin the panel wiring.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/ai");
});

describe("/api/admin/ai-test", () => {
  it("refuses non-management sessions", async () => {
    vi.doMock("@/lib/session", () => ({ requireManagement: vi.fn(async () => null) }));
    vi.doMock("@/lib/ai", () => ({ testAllProviders: vi.fn(async () => []) }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(403);
  });

  it("returns the per-provider verdicts verbatim", async () => {
    vi.doMock("@/lib/session", () => ({
      requireManagement: vi.fn(async () => ({ email: "admin@e2e.test", isAdmin: true })),
    }));
    const results = [
      { name: "groq", configured: true, ok: true, model: "llama-3.3-70b-versatile", ms: 400 },
      { name: "cerebras", configured: true, ok: false, detail: "cerebras 404 - model_not_found" },
      { name: "together", configured: false, ok: false, detail: "no key set" },
    ];
    vi.doMock("@/lib/ai", () => ({ testAllProviders: vi.fn(async () => results) }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual(results);
  });

  it("a crashed sweep returns its own words, not an opaque 500", async () => {
    // The production failure mode this exists for: the panel showed only
    // "the test call itself failed" because every server-side crash reached
    // the client as an unreadable non-JSON 500.
    vi.doMock("@/lib/session", () => ({
      requireManagement: vi.fn(async () => ({ email: "admin@e2e.test", isAdmin: true })),
    }));
    vi.doMock("@/lib/ai", () => ({
      testAllProviders: vi.fn(async () => {
        throw new Error("supabase config read exploded");
      }),
    }));
    const route = await import("../app/api/admin/ai-test/route");
    const res = await route.POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/supabase config read exploded/);
  });
});

describe("testAllProviders contract (source pins)", () => {
  const ai = read("src/lib/ai.ts");

  it("reports the model that ANSWERED and the configured primary separately", () => {
    // A drifted primary rescued by its fallback must be visible as ok-but-
    // drifted, not a silent pass - the exact failure mode callProvider's
    // rescue telemetry exists for.
    expect(ai).toMatch(/configuredModel\?: string/);
    expect(ai).toMatch(/model: r\.model/);
    expect(ai).toMatch(/configuredModel: p\.model/);
  });

  it("an unconfigured provider is reported, never silently skipped", () => {
    expect(ai).toMatch(/configured: false, ok: false, detail: "no key set"/);
  });

  it("a congested primary (429) tries its fallback model, like a dead id does", () => {
    // The owner's live sweep: SambaNova 429 "high demand" on Llama-3.3-70B
    // and OpenRouter 429 "temporarily rate-limited upstream" on the :free
    // primary. Both providers throttle PER MODEL, so the sibling fallback
    // on the same key is the correct next move - gating the rescue on
    // 400/404 alone left both providers red while their fallbacks idled.
    expect(ai).toMatch(/\\b\(400\|404\|429\)\\b/);
  });

  it("one hung provider cannot stall the whole sweep past an infra timeout", () => {
    // Real keys mean real calls: without a hard per-provider deadline the
    // response could take primary+fallback (20s+20s), long enough for the
    // transport in front of Cloud Run - or the phone - to give up, which is
    // exactly the "test call itself failed" the owner hit.
    expect(ai).toMatch(/probe timed out after 12s/);
    expect(ai).toMatch(/callProvider\(p, probe, 16, 10_000\)/);
    expect(ai).toMatch(/clearTimeout\(watchdog\)/);
  });
});

describe("the admin panel wiring", () => {
  const page = read("src/app/admin/page.tsx");

  it("the Test AI providers button renders ABOVE the provider boxes", () => {
    const btn = page.indexOf("Test AI providers");
    const list = page.indexOf("aiProviders.map");
    expect(btn).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(0);
    expect(btn, "button must precede the provider list").toBeLessThan(list);
  });

  it("a fallback-rescued primary renders as a fix-me, not a pass", () => {
    expect(page).toMatch(/t\.model !== t\.configuredModel/);
    expect(page).toMatch(/the fallback answered/);
  });

  it("a failed sweep names WHICH layer failed, never one blanket line", () => {
    // HTTP status vs browser-side failure vs timeout are three different
    // diagnoses; collapsing them made the button undebuggable in production.
    expect(page).toMatch(/aiTestError/);
    expect(page).toMatch(/The server answered HTTP \$\{r\.status\}/);
    expect(page).toMatch(/The request failed in the browser/);
    expect(page).toMatch(/AbortSignal\.timeout\(60_000\)/);
    // The old behavior - every failure collapsing to an empty array with no
    // detail - must stay dead.
    expect(page).not.toMatch(/aiTest\.length === 0/);
  });
});
