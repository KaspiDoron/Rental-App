import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ai = stripComments(readRaw("src/lib/ai.ts"));
const config = stripComments(readRaw("src/lib/config.ts"));
const schema = readRaw("supabase/schema.sql");

// M20 / I-7: CEREBRAS SERVED 0 TOKENS ACROSS 14 CALLS AND 14 FAILOVERS.
//
// The audit refuted three attractive explanations and left exactly two real
// gaps, both of which are about being unable to FIND OUT:
//
//   1. `<PROVIDER>_MODEL` is documented as the live escape hatch for a drifted
//      model id, and the Key Vault allowlist had no `*_MODEL` entries, so
//      `setKey` refused every one of them.
//   2. The provider's own error - status plus body - was thrown, caught into a
//      local array in chatDetailed, and discarded.

describe("the model override is actually settable", () => {
  const MODELS = [
    "GROQ_MODEL",
    "GEMINI_MODEL",
    "OPENROUTER_MODEL",
    "CEREBRAS_MODEL",
    "MISTRAL_MODEL",
    "HUGGINGFACE_MODEL",
    "DEEPSEEK_MODEL",
    "TOGETHER_MODEL",
    "SAMBANOVA_MODEL",
    "GEMINI_VISION_MODEL",
    "GROQ_VISION_MODEL",
  ];

  it("every model id ai.ts reads is in the vault allowlist", () => {
    // setKey rejects anything absent from KEYS, so a key ai.ts reads but the
    // vault will not store is a documented lever that does nothing.
    for (const name of MODELS) {
      expect(ai, `${name} is not read by ai.ts`).toMatch(new RegExp(`getConfig\\("${name}"\\)`));
      expect(config, `${name} is missing from the vault allowlist`).toMatch(
        new RegExp(`name: "${name}"`)
      );
    }
  });

  it("a model id is not masked - it has to be readable to be correctable", () => {
    // `••••2507` cannot be checked against the provider's docs or corrected,
    // which defeats the point of a runtime override.
    for (const name of [...MODELS, "AI_PROVIDER"]) {
      const row = config.slice(config.indexOf(`name: "${name}"`));
      expect(row.slice(0, 200), `${name} should be secret: false`).toMatch(/secret: false/);
    }
  });

  it("secret DEFAULTS to true, so a new key is masked unless stated", () => {
    // The safe direction: forgetting the flag hides a value rather than
    // leaking one.
    expect(config).toMatch(/secret\?: boolean/);
    expect(config).toMatch(/if \(secret === false\) return v \|\| "- not set -"/);
  });

  it("both display paths go through one function", () => {
    // listKeys and setKey each built the display string; only one of them
    // would have been updated.
    expect(config).toMatch(/masked: displayValue\(v, k\.secret\)/);
    expect(config).toMatch(/masked: displayValue\(v, meta\.secret\)/);
  });

  it("the file header no longer claims every value is masked", () => {
    // A comment that lies about what reaches the browser is worse than none.
    expect(readRaw("src/lib/config.ts")).toMatch(/NOT EVERY MANAGED VALUE IS A SECRET/);
  });
});

describe("a failure records why, not just that", () => {
  it("the reason is persisted, not only pushed onto a local array", () => {
    expect(ai).toMatch(/await recordUsage\(cfg\.name, 0, true, cfg\.model, reason\)/);
  });

  it("the row carries the model and the detail", () => {
    expect(ai).toMatch(/model: model \?\? null, detail: detail \? detail\.slice\(0, 300\) : null/);
  });

  it("the detail is bounded, because it is a provider body", () => {
    expect(ai).toMatch(/detail\.slice\(0, 300\)/);
  });

  it("a SUCCESS records the model that actually answered", () => {
    // callProvider silently retries on fallbackModel for a 400/404, so the
    // configured id and the served id are two different facts.
    expect(ai).toMatch(/const \{ text, tokens, model \} = await callProvider/);
    expect(ai).toMatch(/await recordUsage\(cfg\.name, tokens, false, model\)/);
  });

  it("callProvider reports which model it used", () => {
    expect(ai).toMatch(/Promise<\{ text: string; tokens: number; model: string \}>/);
  });

  it("the columns are additive, like every other schema change here", () => {
    expect(schema).toMatch(/alter table public\.ai_usage add column if not exists model text;/);
    expect(schema).toMatch(/alter table public\.ai_usage add column if not exists detail text;/);
  });
});

describe("the panel can show it", () => {
  const admin = stripComments(readRaw("src/app/admin/page.tsx"));

  it("aiStatus carries the last failure per provider", () => {
    expect(ai).toMatch(/lastFailure: fails\[p\.name\] \?\? null/);
  });

  it("it is ONE query, not one per provider", () => {
    // /api/activity is the counter-example in this repo: a fan-out monitor
    // becomes the load it monitors.
    expect(ai).toMatch(/failed=is\.true&order=created_at\.desc&limit=200/);
    const fn = ai.slice(ai.indexOf("async function lastFailures"));
    // One CALL site (the destructured import mentions the name too).
    expect((fn.slice(0, 900).match(/await sbSelect</g) ?? []).length).toBe(1);
  });

  it("an unreadable table means no failure to show, not a crash", () => {
    // Permissive read on purpose: this is diagnostics, not a safety gate.
    const fn = ai.slice(ai.indexOf("async function lastFailures"));
    expect(fn.slice(0, 900)).toMatch(/sbSelect</);
    expect(fn.slice(0, 900)).not.toMatch(/sbSelectStrict/);
  });

  it("the panel renders the reason and the served model", () => {
    expect(admin).toMatch(/p\.lastFailure && \(/);
    expect(admin).toMatch(/sent as \{p\.lastFailure\.model\}/);
    expect(admin).toMatch(/p\.lastFailure\.detail \|\| "no detail recorded"/);
  });
});
