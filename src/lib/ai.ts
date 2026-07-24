// Server-side LLM provider abstraction.
//
// All keys are read from process.env and never leave the server. If no key is
// configured the app returns a deterministic mock so every flow stays fully
// functional in demo mode. Providers are tried in preference order.

import "server-only";
import { getConfig } from "./runtime-config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ProviderName =
  | "groq"
  | "openrouter"
  | "cerebras"
  | "gemini"
  | "mistral"
  | "huggingface"
  | "deepseek"
  | "together"
  | "sambanova";

interface ProviderConfig {
  name: ProviderName;
  token?: string;
  endpoint: string;
  model: string;
  // A safe secondary model on the SAME provider. If the primary model id is
  // rejected (400/404 - ids drift on free tiers), we retry once with this one
  // before failing over to the next provider. Keeps the app resilient to model
  // renames without a redeploy.
  fallbackModel?: string;
}

// Per provider call budget. A hung free-tier endpoint must fail over fast, not
// stall the whole request (this was a cause of the "provider did not respond"
// errors: no timeout meant one slow host blocked everything). Kept under 15s so
// a 2-3 provider failover chain still fits inside the route's 60s maxDuration.
const CALL_TIMEOUT_MS = 14000;

/** Every AI provider token key, in default failover order. */
export const PROVIDER_NAMES: ProviderName[] = [
  "groq",
  "cerebras",
  "sambanova",
  "deepseek",
  "together",
  "openrouter",
  "mistral",
  "huggingface",
  "gemini",
];

async function allProviders(): Promise<ProviderConfig[]> {
  const [groq, openrouter, cerebras, gemini, mistral, huggingface, deepseek, together, sambanova] =
    await Promise.all([
      getConfig("GROQ_TOKEN"),
      getConfig("OPENROUTER_TOKEN"),
      getConfig("CEREBRAS_TOKEN"),
      getConfig("GEMINI_TOKEN"),
      getConfig("MISTRAL_TOKEN"),
      getConfig("HUGGINGFACE_TOKEN"),
      getConfig("DEEPSEEK_TOKEN"),
      getConfig("TOGETHER_TOKEN"),
      getConfig("SAMBANOVA_TOKEN"),
    ]);
  // Optional per-provider MODEL override (vault/env `<PROVIDER>_MODEL`). Free-tier
  // model ids drift constantly - a rename 404s the whole provider. This lets the
  // owner pin or upgrade any provider's model LIVE from Admin -> Keys with no
  // redeploy (paste e.g. `CEREBRAS_MODEL = qwen-3-235b-a22b-instruct-2507`).
  // Blank -> the strong default below. The fallbackModel still covers a bad id.
  const [groqM, orM, cerM, gemM, misM, hfM, dsM, togM, sambaM] = await Promise.all([
    getConfig("GROQ_MODEL"),
    getConfig("OPENROUTER_MODEL"),
    getConfig("CEREBRAS_MODEL"),
    getConfig("GEMINI_MODEL"),
    getConfig("MISTRAL_MODEL"),
    getConfig("HUGGINGFACE_MODEL"),
    getConfig("DEEPSEEK_MODEL"),
    getConfig("TOGETHER_MODEL"),
    getConfig("SAMBANOVA_MODEL"),
  ]);
  const pick = (override: string | undefined, def: string) =>
    (override && override.trim()) || def;

  // Every provider runs a TOP-TIER model (70B+/frontier), so whichever key the
  // owner has, the agents get a strong brain. Order = default failover priority
  // (fastest + steadiest free tiers first). All are OpenAI-compatible except
  // Gemini, which the chat() path special-cases.
  return [
    {
      name: "groq",
      token: groq,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      // Kimi-K2: a frontier-class open model, served fast on Groq's free tier.
      model: pick(groqM, "moonshotai/kimi-k2-instruct"),
      // Llama-3.3-70B is always live on Groq - a rock-solid fallback.
      fallbackModel: "llama-3.3-70b-versatile",
    },
    {
      name: "cerebras",
      token: cerebras,
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      // llama-3.3-70b is Cerebras' flagship; Llama-4 Scout is the current
      // fallback (the old llama3.1-70b was retired -> 404).
      model: pick(cerM, "llama-3.3-70b"),
      fallbackModel: "llama-4-scout-17b-16e-instruct",
    },
    {
      name: "sambanova",
      token: sambanova,
      endpoint: "https://api.sambanova.ai/v1/chat/completions",
      // Meta-Llama-3.1-* were deprecated on SambaNova Cloud (HTTP 410).
      // 3.3-70B is current; Llama-4 Maverick is the newer fallback.
      model: pick(sambaM, "Meta-Llama-3.3-70B-Instruct"),
      fallbackModel: "Llama-4-Maverick-17B-128E-Instruct",
    },
    {
      name: "deepseek",
      token: deepseek,
      endpoint: "https://api.deepseek.com/chat/completions",
      // deepseek-chat was retired: the API now requires deepseek-v4-pro (top
      // tier) or deepseek-v4-flash (the fast fallback).
      model: pick(dsM, "deepseek-v4-pro"),
      fallbackModel: "deepseek-v4-flash",
    },
    {
      name: "together",
      token: together,
      endpoint: "https://api.together.xyz/v1/chat/completions",
      model: pick(togM, "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"),
      fallbackModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    },
    {
      name: "openrouter",
      token: openrouter,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      // Frontier open model, free tier on OpenRouter.
      model: pick(orM, "deepseek/deepseek-chat-v3.1:free"),
      fallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
    },
    {
      name: "mistral",
      token: mistral,
      endpoint: "https://api.mistral.ai/v1/chat/completions",
      model: pick(misM, "mistral-large-latest"),
      fallbackModel: "open-mistral-nemo",
    },
    {
      name: "huggingface",
      token: huggingface,
      endpoint: "https://router.huggingface.co/v1/chat/completions",
      model: pick(hfM, "meta-llama/Llama-3.3-70B-Instruct"),
    },
    {
      name: "gemini",
      token: gemini,
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      // gemini-2.0-flash lost its free tier (limit 0). 2.5-flash still has a
      // free tier; gemini-flash-latest is the higher-quota rolling fallback.
      model: pick(gemM, "gemini-2.5-flash"),
      fallbackModel: "gemini-flash-latest",
    },
  ];
}

// ---- free-tier reset cadence (documented estimates, NOT an API contract) -----
// Providers change these without notice and rarely expose the live allowance, so
// this drives the "resets daily/monthly" label + the used-this-cycle window only.
// Where a provider DOES expose a live figure (OpenRouter $, DeepSeek balance),
// aiStatus fetches it and that is authoritative.
type Cadence = "day" | "month" | "none";
const PROVIDER_META: Record<ProviderName, { cadence: Cadence; note: string }> = {
  groq: { cadence: "day", note: "Free tier resets DAILY (per-day token + request caps)." },
  cerebras: { cadence: "day", note: "Free tier resets DAILY (per-day token cap)." },
  gemini: { cadence: "day", note: "Free tier resets DAILY (requests-per-day), ~midnight PT." },
  openrouter: { cadence: "day", note: "Free models cap requests-per-DAY; $ credit shown live." },
  sambanova: { cadence: "day", note: "Free tier resets DAILY (per-day + per-minute caps)." },
  mistral: { cadence: "month", note: "Free tier is a MONTHLY token allowance." },
  huggingface: { cadence: "month", note: "Router credits reset MONTHLY." },
  together: { cadence: "none", note: "One-time free credit; free models are per-minute rate-limited." },
  deepseek: { cadence: "none", note: "Pay-as-you-go balance (shown live); no free reset." },
};

/** Start of the current cadence window as an ISO instant (UTC). */
function cycleStart(cadence: Cadence): Date | null {
  if (cadence === "none") return null;
  const n = new Date();
  return cadence === "day"
    ? new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
    : new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

/** Tokens we have spent per provider within THIS provider's reset window. */
async function cycleUsage(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { sbSelect } = await import("./runtime-config");
    // One query over the widest window (a month), then bucket per provider by
    // its own cadence. Cheap enough for an admin-only panel.
    const monthStart = cycleStart("month")!;
    const rows = await sbSelect<{ provider: string; tokens: number; created_at: string }>(
      "ai_usage",
      `select=provider,tokens,created_at&created_at=gte.${monthStart.toISOString()}&limit=100000`
    );
    const dayStartMs = cycleStart("day")!.getTime();
    const monthStartMs = monthStart.getTime();
    for (const r of rows) {
      const meta = PROVIDER_META[r.provider as ProviderName];
      if (!meta || meta.cadence === "none") continue;
      const boundary = meta.cadence === "day" ? dayStartMs : monthStartMs;
      if (Date.parse(r.created_at) >= boundary) {
        out[r.provider] = (out[r.provider] ?? 0) + (Number(r.tokens) || 0);
      }
    }
  } catch {
    /* usage is best-effort - the panel still shows in-memory "used here" */
  }
  return out;
}

// Current Gemini model used by every Gemini call (chat + vision).
export const GEMINI_MODEL = "gemini-2.5-flash";

/** Configured providers, preferred one first (automatic failover order). */
async function providers(): Promise<ProviderConfig[]> {
  const all = await allProviders();
  const preferred = ((await getConfig("AI_PROVIDER")) || "").toLowerCase();
  const withKeys = all.filter((p) => p.token);
  withKeys.sort((a, b) =>
    a.name === preferred ? -1 : b.name === preferred ? 1 : 0
  );
  return withKeys;
}

/** True when at least one real provider key is configured. */
export async function aiEnabled(): Promise<boolean> {
  return (await providers()).length > 0;
}

// ---- usage accounting (per provider, per instance + durable log) ------------

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_ai_usage__:
    | Record<string, { requests: number; tokens: number; failures: number }>
    | undefined;
}

function usageStore() {
  if (!globalThis.__wheeldeal_ai_usage__) globalThis.__wheeldeal_ai_usage__ = {};
  return globalThis.__wheeldeal_ai_usage__;
}

async function recordUsage(provider: string, tokens: number, failed = false) {
  const s = usageStore();
  if (!s[provider]) s[provider] = { requests: 0, tokens: 0, failures: 0 };
  s[provider].requests += 1;
  s[provider].tokens += tokens;
  if (failed) s[provider].failures += 1;
  const { sbInsert } = await import("./runtime-config");
  sbInsert("ai_usage", [{ provider, tokens, failed }]).catch(() => {});
}

/** Live status of every AI provider: configured, our usage, remote quota. */
export async function aiStatus() {
  const list = await allProviders();
  const preferred = ((await getConfig("AI_PROVIDER")) || "").toLowerCase();
  const s = usageStore();
  const cyc = await cycleUsage();

  return Promise.all(
    list.map(async (p) => {
      let remaining: string | null = null;
      // OpenRouter exposes a clean $-quota endpoint.
      if (p.name === "openrouter" && p.token) {
        try {
          const res = await fetch("https://openrouter.ai/api/v1/key", {
            headers: { Authorization: `Bearer ${p.token}` },
            cache: "no-store",
          });
          const d = await res.json();
          if (res.ok && d?.data) {
            const used = d.data.usage ?? 0;
            const limit = d.data.limit;
            remaining =
              limit === null || limit === undefined
                ? `$${Number(used).toFixed(4)} used (no hard limit)`
                : `$${(limit - used).toFixed(2)} of $${limit} left`;
          }
        } catch {
          /* leave unknown */
        }
      }
      // DeepSeek exposes a live balance endpoint.
      if (p.name === "deepseek" && p.token) {
        try {
          const res = await fetch("https://api.deepseek.com/user/balance", {
            headers: { Authorization: `Bearer ${p.token}` },
            cache: "no-store",
          });
          const d = await res.json();
          const b = d?.balance_infos?.[0];
          if (res.ok && b) remaining = `${b.total_balance} ${b.currency} balance`;
        } catch {
          /* leave unknown */
        }
      }
      const meta = PROVIDER_META[p.name];
      return {
        name: p.name,
        model: p.model,
        configured: Boolean(p.token),
        preferred: p.name === preferred,
        requests: s[p.name]?.requests ?? 0,
        tokensUsed: s[p.name]?.tokens ?? 0,
        failures: s[p.name]?.failures ?? 0,
        remaining, // null = the provider does not expose remaining quota
        // Free-tier cycle: OUR measured spend this window + the documented reset.
        usedThisCycle: cyc[p.name] ?? 0,
        cadence: meta.cadence, // "day" | "month" | "none"
        cadenceNote: meta.note,
      };
    })
  );
}

/**
 * The EXACT endpoint + model the app will use for a provider token key, so the
 * admin "Test API" button probes what production actually runs (respecting any
 * `<PROVIDER>_MODEL` override) instead of a separately-hardcoded id that drifts.
 * Returns null for non-AI keys.
 */
export async function aiProviderTestTarget(
  tokenKey: string
): Promise<{ endpoint: string; model: string; gemini: boolean } | null> {
  const byKey: Record<string, ProviderName> = {
    GROQ_TOKEN: "groq",
    OPENROUTER_TOKEN: "openrouter",
    CEREBRAS_TOKEN: "cerebras",
    GEMINI_TOKEN: "gemini",
    MISTRAL_TOKEN: "mistral",
    HUGGINGFACE_TOKEN: "huggingface",
    DEEPSEEK_TOKEN: "deepseek",
    TOGETHER_TOKEN: "together",
    SAMBANOVA_TOKEN: "sambanova",
  };
  const name = byKey[tokenKey];
  if (!name) return null;
  const p = (await allProviders()).find((x) => x.name === name);
  return p ? { endpoint: p.endpoint, model: p.model, gemini: p.name === "gemini" } : null;
}

/** fetch with a hard timeout so one slow provider cannot stall the request. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Trim a provider error body to a short, safe diagnostic (never leaks the key).
async function errorDetail(res: Response, name: string): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  const msg = body.replace(/\s+/g, " ").trim();
  return `${name} ${res.status}${msg ? ` - ${msg}` : ""}`;
}

async function callOpenAICompatible(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  const res = await fetchWithTimeout(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      max_tokens: maxTokens,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(await errorDetail(res, cfg.name));
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    tokens: data.usage?.total_tokens ?? 0,
  };
}

async function callGemini(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const endpoint = cfg.endpoint.replace(/models\/[^:]+:/, `models/${model}:`);
  const res = await fetchWithTimeout(`${endpoint}?key=${cfg.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens },
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(await errorDetail(res, "gemini"));
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "",
    tokens: data.usageMetadata?.totalTokenCount ?? 0,
  };
}

// One provider attempt: primary model, then its fallback model on a model-id
// error (400/404). Returns text or throws with a readable reason.
async function callProvider(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ text: string; tokens: number }> {
  const run = (model: string) =>
    cfg.name === "gemini"
      ? callGemini(cfg, messages, model, maxTokens, timeoutMs)
      : callOpenAICompatible(cfg, messages, model, maxTokens, timeoutMs);
  try {
    return await run(cfg.model);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const modelIssue = /\b(400|404)\b/.test(reason);
    if (cfg.fallbackModel && modelIssue) {
      return run(cfg.fallbackModel);
    }
    throw e;
  }
}

/**
 * Run a chat completion against the first healthy provider.
 * Returns null when no provider is configured (caller should fall back to mock).
 */
export async function chat(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; budgetMs?: number }
): Promise<string | null> {
  return (await chatDetailed(messages, opts)).text;
}

/**
 * Like chat(), but also returns which provider answered and, on total failure,
 * a readable reason (the last provider error) so callers can show something
 * useful instead of a generic "did not respond".
 */
export async function chatDetailed(
  messages: ChatMessage[],
  opts?: { maxTokens?: number; budgetMs?: number; preferProvider?: ProviderName }
): Promise<{ text: string | null; provider?: ProviderName; error?: string }> {
  let list = await providers();
  // preferProvider hoists one provider to the front WHEN it is configured
  // (used by the distillation "teacher" to prefer DeepSeek, while still falling
  // back to the free chain when no DeepSeek key exists). Not a hard pin.
  if (opts?.preferProvider) {
    const pref = opts.preferProvider;
    list = [...list].sort((a, b) => (a.name === pref ? -1 : b.name === pref ? 1 : 0));
  }
  if (list.length === 0) {
    return { text: null, error: "No AI provider key is configured. Add one in Admin -> Keys." };
  }
  const maxTokens = opts?.maxTokens ?? 900;
  const errors: string[] = [];
  // Total chain budget: however many providers are configured, the whole
  // failover run must finish well inside the route's 60s maxDuration. Callers
  // on a user-facing hot path (search start) pass a much tighter budget and
  // fall back to their deterministic heuristic instead of making people wait.
  const deadline = Date.now() + (opts?.budgetMs ?? 38_000);

  for (const cfg of list) {
    if (Date.now() > deadline) {
      errors.push("time budget exhausted before trying remaining providers");
      break;
    }
    try {
      // Never let one call overshoot the caller's total budget.
      const remaining = Math.max(2_000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()));
      const { text, tokens } = await callProvider(cfg, messages, maxTokens, remaining);
      await recordUsage(cfg.name, tokens);
      if (text) return { text, provider: cfg.name };
      errors.push(`${cfg.name}: empty reply`);
    } catch (e) {
      // Automatic failover: log the failure and try the next provider.
      await recordUsage(cfg.name, 0, true);
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { text: null, error: errors[errors.length - 1] ?? "All AI providers failed." };
}

// ---- vision ------------------------------------------------------------------

export interface VisionAttempt {
  provider: "gemini" | "groq";
  model: string;
  ok: boolean;
  /** Exact upstream error (status + body excerpt) when the attempt failed. */
  error?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wd_vision_diag__: { at: number; attempts: VisionAttempt[] } | undefined;
}

/**
 * The attempt log of the most recent vision call on this instance - which
 * providers/models were tried and the VERBATIM upstream error of each failure.
 * The Media Lab reads this so "the image agent is broken" always comes with
 * the exact reason (e.g. Gemini 429 quota, Groq 400 model decommissioned).
 */
export function lastVisionDiagnostics(): VisionAttempt[] {
  return globalThis.__wd_vision_diag__?.attempts ?? [];
}

// Groq's multimodal Llama-4 models (Scout first - faster; Maverick fallback).
const GROQ_VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
];
// gemini-2.5-flash-lite 404s for NEW API keys ("no longer available to new
// users" - seen verbatim in the owner's Media Lab), so the rolling aliases
// come right after the pinned primary.
const GEMINI_VISION_MODELS = [
  GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.0-flash",
];

/**
 * Vision chat: text + images (raw base64+mime). Tries every Gemini vision
 * model, then every Groq Llama-4 vision model - NO silent failures: each
 * attempt's exact upstream error is recorded (see lastVisionDiagnostics).
 * Returns null only when every configured provider genuinely failed.
 */
export async function chatVision(
  system: string,
  userText: string,
  images: { mime: string; base64: string }[]
): Promise<string | null> {
  const attempts: VisionAttempt[] = [];
  globalThis.__wd_vision_diag__ = { at: Date.now(), attempts };

  const [gemini, groq] = await Promise.all([getConfig("GEMINI_TOKEN"), getConfig("GROQ_TOKEN")]);
  if (!gemini) attempts.push({ provider: "gemini", model: "(all)", ok: false, error: "GEMINI_TOKEN is not configured" });
  if (!groq) attempts.push({ provider: "groq", model: "(all)", ok: false, error: "GROQ_TOKEN is not configured" });

  if (gemini) {
    for (const model of GEMINI_VISION_MODELS) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gemini}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: userText },
                    ...images.map((img) => ({
                      inline_data: { mime_type: img.mime, data: img.base64 },
                    })),
                  ],
                },
              ],
              generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
            }),
          }
        );
        if (!res.ok) {
          attempts.push({ provider: "gemini", model, ok: false, error: await errorDetail(res, "gemini") });
          continue;
        }
        const data = await res.json();
        const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (out) {
          attempts.push({ provider: "gemini", model, ok: true });
          await recordUsage("gemini", data.usageMetadata?.totalTokenCount ?? 0);
          return out;
        }
        attempts.push({ provider: "gemini", model, ok: false, error: "empty reply (possibly safety-blocked)" });
      } catch (e) {
        attempts.push({
          provider: "gemini",
          model,
          ok: false,
          error: e instanceof Error ? e.message : "network error",
        });
      }
    }
  }

  // Groq vision (Llama-4 is multimodal): image reading must never depend on
  // Gemini alone - most deployments have a GROQ_TOKEN. Only image parts are
  // sent (audio has its own Groq-Whisper path in graph/transcribe.ts).
  const groqImages = images.filter((i) => (i.mime || "").startsWith("image/"));
  if (groq && groqImages.length > 0) {
    for (const model of GROQ_VISION_MODELS) {
      try {
        const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groq}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 700,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: `${system}\n\n${userText}` },
                  ...groqImages.map((img) => ({
                    type: "image_url",
                    image_url: { url: `data:${img.mime || "image/jpeg"};base64,${img.base64}` },
                  })),
                ],
              },
            ],
          }),
        });
        if (!res.ok) {
          attempts.push({ provider: "groq", model, ok: false, error: await errorDetail(res, "groq") });
          continue;
        }
        const data = await res.json();
        const out = data.choices?.[0]?.message?.content?.trim();
        if (out) {
          attempts.push({ provider: "groq", model, ok: true });
          await recordUsage("groq", data.usage?.total_tokens ?? 0);
          return out;
        }
        attempts.push({ provider: "groq", model, ok: false, error: "empty reply" });
      } catch (e) {
        attempts.push({
          provider: "groq",
          model,
          ok: false,
          error: e instanceof Error ? e.message : "network error",
        });
      }
    }
  } else if (groq && images.length > 0 && groqImages.length === 0) {
    attempts.push({ provider: "groq", model: "(vision)", ok: false, error: "no image parts (audio-only input)" });
  }
  return null;
}

/**
 * Grounded chat: a single Gemini call with Google Search grounding enabled, so
 * the model answers from REAL current web results (used to research live rental
 * market floors). Returns the text plus any source URLs Gemini cites. Null when
 * no Gemini key is set, so callers fall back to an ungrounded estimate.
 */
export async function chatGrounded(
  system: string,
  user: string
): Promise<{ text: string; sources: string[] } | null> {
  const key = await getConfig("GEMINI_TOKEN");
  if (!key) return null;
  // 2.5-flash supports the google_search tool; lite is the higher-quota fallback.
  const models = [GEMINI_MODEL, "gemini-flash-latest", "gemini-flash-lite-latest"];
  for (const model of models) {
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
          }),
        }
      );
      if (!res.ok) continue; // 429/404 - try the next model
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim();
      if (!text) continue;
      const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
      const sources: string[] = chunks
        .map((c: any) => c?.web?.uri)
        .filter(Boolean)
        .slice(0, 6);
      await recordUsage("gemini", data.usageMetadata?.totalTokenCount ?? 0);
      return { text, sources };
    } catch {
      /* try next model */
    }
  }
  return null;
}

/** Extract the first JSON object from an LLM response, tolerating code fences. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
