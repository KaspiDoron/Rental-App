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
});
