import { describe, it, expect, vi, afterEach } from "vitest";
import { retirementsFrom } from "./i18n-retry";

// THE FAQ THAT COULD NEVER TRANSLATE.
//
// FaqSection called tShared(), the client queued the strings, and the server's
// catalogue allowlist silently filtered every one of them out - a clean 200
// with an empty map, which the client read as "declined" and retired the whole
// batch for the session. Hebrew showed English FAQ forever, with zero errors
// anywhere. These tests execute both halves of the fix: the server's shared
// scope with its own owner-bounded allowlist and cache row, and the client's
// bounded-patience retirement rule.

describe("retirementsFrom - an empty answer is a strike, not a life sentence", () => {
  it("a response that translated something retires its misses, as before", () => {
    const strikes = new Map<string, number>([["b", 2]]);
    const out = retirementsFrom(["a", "b"], { map: { a: "X" } }, strikes);
    expect(out).toEqual(["b"]);
    // A working pipeline resets the patience counter.
    expect(strikes.size).toBe(0);
  });

  it("named rejections retire immediately - the server DID answer", () => {
    const out = retirementsFrom(
      ["a"],
      { map: {}, rejected: [{ text: "a" }] },
      new Map()
    );
    expect(out).toEqual(["a"]);
  });

  it("an entirely empty answer retires nothing until the third strike", () => {
    const strikes = new Map<string, number>();
    expect(retirementsFrom(["a", "b"], { map: {} }, strikes)).toEqual([]);
    expect(retirementsFrom(["a", "b"], { map: {} }, strikes)).toEqual([]);
    // Third consecutive empty answer: the no-loop guarantee kicks in.
    expect(retirementsFrom(["a", "b"], { map: {} }, strikes)).toEqual(["a", "b"]);
  });
});

const FAQ = [
  { id: "q1", q: "How does WheelDeal actually get me a cheaper price?", a: "You tell us the vehicle and dates." },
  { id: "q2", q: "What currency are the prices in?", a: "Always the shop's local currency." },
];

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/session");
  vi.doUnmock("@/lib/usage");
  vi.doUnmock("@/lib/ai");
  vi.doUnmock("@/lib/runtime-config");
  vi.doUnmock("@/lib/faq");
  vi.doUnmock("@/lib/i18n-overrides");
});

function mockStack(writes: Record<string, string>) {
  vi.doMock("@/lib/session", () => ({
    getSession: vi.fn(async () => ({ email: "t@e2e.test", role: "user" })),
  }));
  vi.doMock("@/lib/usage", () => ({
    checkDailyLimit: vi.fn(async () => ({ allowed: true })),
    recordApi: vi.fn(async () => {}),
  }));
  vi.doMock("@/lib/ai", () => ({
    aiEnabled: vi.fn(async () => true),
    // Echo-translator: answers every brief so validation passes and the
    // route's learning path runs for real.
    chat: vi.fn(async (messages: { role: string; content: string }[]) => {
      const briefs = JSON.parse(messages.find((m) => m.role === "user")!.content) as {
        text: string;
      }[];
      return JSON.stringify({ t: briefs.map((b) => `HE:${b.text}`) });
    }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    getConfigExact: vi.fn(async () => undefined),
    setConfig: vi.fn(async (key: string, value: string) => {
      writes[key] = value;
      return { ok: true, persistent: true };
    }),
  }));
  vi.doMock("@/lib/faq", () => ({ listFaq: vi.fn(async () => FAQ) }));
  vi.doMock("@/lib/i18n-overrides", () => ({
    readOverrides: vi.fn(async () => ({})),
    applyOverrides: (cached: Record<string, string>) => cached,
  }));
}

function post(body: unknown) {
  return new Request("http://local/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/translate shared scope (EXECUTED)", () => {
  it("FAQ strings translate through `shared` and land in their OWN cache row", async () => {
    const writes: Record<string, string> = {};
    mockStack(writes);
    const route = await import("../app/api/translate/route");
    const res = await route.POST(
      post({ lang: "he", langName: "Hebrew", texts: [], shared: [FAQ[0].q, FAQ[0].a] })
    );
    expect(res.status).toBe(200);
    const { map } = (await res.json()) as { map: Record<string, string> };
    expect(map[FAQ[0].q]).toBe(`HE:${FAQ[0].q}`);
    expect(map[FAQ[0].a]).toBe(`HE:${FAQ[0].a}`);
    // The shared row, never the app-copy row - the bounded-reads argument
    // for I18N_<lang> survives because owner text cannot grow it.
    expect(Object.keys(writes)).toEqual(["I18N_SHARED_he"]);
    expect(writes["I18N_SHARED_he"]).toContain(`HE:${FAQ[0].q}`);
  });

  it("a shared string that is NOT live FAQ content is dropped, not translated", async () => {
    const writes: Record<string, string> = {};
    mockStack(writes);
    const route = await import("../app/api/translate/route");
    const res = await route.POST(
      post({ lang: "he", shared: ["Sun House shop replied 250 THB - a leak attempt"] })
    );
    const { map } = (await res.json()) as { map: Record<string, string> };
    // No translation, no cache write - the egress gate holds for the shared
    // scope exactly as the catalogue holds for app copy.
    expect(Object.keys(map)).toHaveLength(0);
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it("both scopes in one request write both rows and answer one merged map", async () => {
    const writes: Record<string, string> = {};
    mockStack(writes);
    const route = await import("../app/api/translate/route");
    const { I18N_CATALOG } = await import("./i18n-catalog");
    const appCopy = I18N_CATALOG[0];
    const res = await route.POST(
      post({ lang: "he", texts: [appCopy], shared: [FAQ[1].q] })
    );
    const { map } = (await res.json()) as { map: Record<string, string> };
    expect(map[appCopy]).toBe(`HE:${appCopy}`);
    expect(map[FAQ[1].q]).toBe(`HE:${FAQ[1].q}`);
    expect(Object.keys(writes).sort()).toEqual(["I18N_SHARED_he", "I18N_he"]);
  });
});
