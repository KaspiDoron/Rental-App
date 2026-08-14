import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// WAVE 2 (owner report 5 #13) - PREMIUM PROVIDERS THE OWNER CAN PAY FOR.
//
// OpenAI, Anthropic and Kimi join the chain: last in the default failover
// order (a free rung answering means no bill), first on premium-tier calls
// (SPTE's pickRoute Tier M - which used to compute a tier and route nothing).
// Anthropic speaks its own dialect (/v1/messages, x-api-key); OpenAI's newer
// models reject the classic sampler params; Kimi is OpenAI-compatible.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ai = read("src/lib/ai.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["ANTHROPIC_TOKEN", "OPENAI_TOKEN", "KIMI_TOKEN", "GROQ_TOKEN"]) {
    delete process.env[k];
  }
});

describe("the paid trio is registered everywhere a provider must be", () => {
  it("in the union, the failover order (LAST), and the compile-forced meta", () => {
    const open = ai.indexOf("= [", ai.indexOf("PROVIDER_NAMES"));
    const table = ai.slice(open, ai.indexOf("]", open));
    for (const name of ['"anthropic"', '"openai"', '"kimi"']) {
      expect(table).toContain(name);
      // Paid AFTER the whole free chain - gemini is the last free rung.
      expect(table.indexOf(name)).toBeGreaterThan(table.indexOf('"gemini"'));
    }
    // PROVIDER_META is a total Record over ProviderName - these entries are
    // what make the build fail if someone adds a name without the meta.
    expect(ai).toMatch(/openai: \{ cadence: "none", note: "PAID per token/);
    expect(ai).toMatch(/anthropic: \{\s*[\r\n]\s*cadence: "none"/);
    expect(ai).toMatch(/kimi: \{ cadence: "none", note: "PAID per token/);
  });

  it("in the RPM budgeter - unknown would mean UNLIMITED for exactly the rungs that bill", () => {
    const rpm = read("src/lib/ai-rpm.ts");
    expect(rpm).toMatch(/anthropic: \d+/);
    expect(rpm).toMatch(/openai: \d+/);
    expect(rpm).toMatch(/kimi: \d+/);
  });

  it("in the key vault + docs links + test-target map", () => {
    const config = read("src/lib/config.ts");
    for (const k of ["ANTHROPIC_TOKEN", "OPENAI_TOKEN", "KIMI_TOKEN", "ANTHROPIC_MODEL", "OPENAI_MODEL", "KIMI_MODEL"]) {
      expect(config, `${k} missing from the vault allowlist`).toContain(`name: "${k}"`);
    }
    for (const k of ["ANTHROPIC_TOKEN:", "OPENAI_TOKEN:", "KIMI_TOKEN:"]) {
      expect(config, `${k} has no Get-key link`).toContain(k);
    }
    expect(ai).toMatch(/ANTHROPIC_TOKEN: "anthropic"/);
    expect(ai).toMatch(/OPENAI_TOKEN: "openai"/);
    expect(ai).toMatch(/KIMI_TOKEN: "kimi"/);
  });
});

describe("dispatch is by DIALECT, not by name equality", () => {
  it("the call path branches on cfg.dialect and anthropic has its own adapter", () => {
    expect(ai).toMatch(/cfg\.dialect === "gemini"/);
    expect(ai).toMatch(/cfg\.dialect === "anthropic"/);
    expect(ai).toMatch(/async function callAnthropic/);
    // The old buried special case is gone from the dispatch.
    expect(ai).not.toMatch(/\.\.\.\(cfg\.name === "gemini"/);
  });

  it("Anthropic's grammar: x-api-key, version header, top-level system, split usage", () => {
    const fn = ai.slice(ai.indexOf("async function callAnthropic"), ai.indexOf("async function callProvider"));
    expect(fn).toMatch(/"x-api-key": cfg\.token/);
    expect(fn).toMatch(/"anthropic-version": "2023-06-01"/);
    expect(fn).toMatch(/\.\.\.\(system \? \{ system \} : \{\}\)/);
    expect(fn).toMatch(/input_tokens.*output_tokens/s);
  });

  it("OpenAI's reasoning sampler: max_completion_tokens, no temperature", () => {
    expect(ai).toMatch(/cfg\.sampler === "reasoning"\s*[\r\n]?\s*\? \{ max_completion_tokens: maxTokens \}/);
  });

  it("Anthropic's 529 overload earns the sibling-model rescue, additively", () => {
    // The original pinned literal survives verbatim...
    expect(ai).toMatch(/\\b\(400\|404\|429\)\\b/);
    // ...and 529 joins it.
    expect(ai).toMatch(/\\b529\\b/);
  });
});

describe("EXECUTED: callAnthropic speaks the real wire shape", () => {
  it("maps messages -> /v1/messages and reads content blocks + usage back", async () => {
    process.env.ANTHROPIC_TOKEN = "fake-key";
    let seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        if (!String(url).includes("anthropic")) {
          return new Response(JSON.stringify({ error: "wrong host" }), { status: 500 });
        }
        seen = { url: String(url), headers: init?.headers, body: JSON.parse(init?.body ?? "{}") };
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "sawadee" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 }
        );
      })
    );
    const { testAllProviders } = await import("./ai");
    const r = (await testAllProviders()).find((x) => x.name === "anthropic");
    expect(r?.ok).toBe(true);
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers?.["x-api-key"]).toBe("fake-key");
    expect(seen.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers?.Authorization).toBeUndefined();
    expect(seen.body?.model).toBe("claude-sonnet-5");
    expect(Array.isArray(seen.body?.messages)).toBe(true);
  });
});

describe("the premium tier is REAL routing, not a computed label", () => {
  it("chatDetailed hoists paid providers on tier:'premium'", () => {
    expect(ai).toMatch(/opts\?\.tier === "premium"/);
    expect(ai).toMatch(/list\.filter\(\(p\) => p\.paid\), \.\.\.list\.filter\(\(p\) => !p\.paid\)/);
  });

  it("SPTE's Tier M actually reaches the model call now", () => {
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/route\.tier === "M" \? \{ tier: "premium" as const \} : \{\}/);
  });
});

describe("the vision ladder gained a verified paid rescue rung", () => {
  it("Anthropic vision joins LAST (a rescue, not the default spend), override-able", () => {
    expect(ai).toMatch(/async function anthropicVisionAttempt/);
    expect(ai).toMatch(/getConfig\("ANTHROPIC_VISION_MODEL"\)/);
    // The rung uses the same frame-scaled output ceiling as Gemini's.
    const fn = ai.slice(ai.indexOf("async function anthropicVisionAttempt"), ai.indexOf("READ IMAGES, AND SAY"));
    expect(fn).toMatch(/Math\.min\(6_144, 2_048 \+ 512 \* Math\.max\(0, images\.length - 1\)\)/);
    // Ladder appends anthropic AFTER the groq rungs.
    const ladderRegion = ai.slice(ai.indexOf("const ladder: Array<"), ai.indexOf("const perCall"));
    expect(ladderRegion.indexOf('provider: "anthropic"')).toBeGreaterThan(
      ladderRegion.indexOf('provider: "groq"')
    );
  });

  it("the key-test button speaks anthropic's grammar instead of falling through", () => {
    const route = read("src/app/api/admin/key-test/route.ts");
    expect(route).toMatch(/target\.dialect === "anthropic"/);
    expect(route).toMatch(/"anthropic-version": "2023-06-01"/);
    // And the OpenAI test respects the reasoning sampler.
    expect(route).toMatch(/reasoningSampler: target\.sampler === "reasoning"/);
    expect(route).toMatch(/max_completion_tokens: 2/);
  });
});
