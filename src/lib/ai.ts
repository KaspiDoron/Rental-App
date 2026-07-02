// Server-side LLM provider abstraction.
//
// All keys are read from process.env and never leave the server. If no key is
// configured the app returns a deterministic mock so every flow stays fully
// functional in demo mode. Providers are tried in preference order.

import "server-only";
import { getConfig } from "./runtime-config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ProviderName = "groq" | "openrouter" | "cerebras" | "gemini";

interface ProviderConfig {
  name: ProviderName;
  token?: string;
  endpoint: string;
  model: string;
}

async function providers(): Promise<ProviderConfig[]> {
  const [groq, openrouter, cerebras, gemini, pref] = await Promise.all([
    getConfig("GROQ_TOKEN"),
    getConfig("OPENROUTER_TOKEN"),
    getConfig("CEREBRAS_TOKEN"),
    getConfig("GEMINI_TOKEN"),
    getConfig("AI_PROVIDER"),
  ]);

  const all: ProviderConfig[] = [
    {
      name: "groq",
      token: groq,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
    },
    {
      name: "openrouter",
      token: openrouter,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "meta-llama/llama-3.1-8b-instruct",
    },
    {
      name: "cerebras",
      token: cerebras,
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      model: "llama3.1-8b",
    },
    {
      name: "gemini",
      token: gemini,
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      model: "gemini-1.5-flash",
    },
  ];

  const preferred = (pref || "").toLowerCase();
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

async function callOpenAICompatible(
  cfg: ProviderConfig,
  messages: ChatMessage[]
): Promise<string> {
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.6,
      max_tokens: 700,
    }),
  });
  if (!res.ok) throw new Error(`${cfg.name} ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callGemini(
  cfg: ProviderConfig,
  messages: ChatMessage[]
): Promise<string> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const res = await fetch(`${cfg.endpoint}?key=${cfg.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature: 0.6, maxOutputTokens: 700 },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ""
  );
}

/**
 * Run a chat completion against the first healthy provider.
 * Returns null when no provider is configured (caller should fall back to mock).
 */
export async function chat(messages: ChatMessage[]): Promise<string | null> {
  const list = await providers();
  if (list.length === 0) return null;

  for (const cfg of list) {
    try {
      const text =
        cfg.name === "gemini"
          ? await callGemini(cfg, messages)
          : await callOpenAICompatible(cfg, messages);
      if (text) return text;
    } catch {
      // try the next provider
    }
  }
  return null;
}

/**
 * Vision chat: text + images (data URLs or raw base64+mime). Uses Gemini when
 * available (best free-tier vision); returns null when no vision provider is
 * configured so callers fall back to a low-confidence heuristic.
 */
export async function chatVision(
  system: string,
  userText: string,
  images: { mime: string; base64: string }[]
): Promise<string | null> {
  const key = await getConfig("GEMINI_TOKEN");
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
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
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
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
