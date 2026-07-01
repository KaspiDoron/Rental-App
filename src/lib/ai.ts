// Server-side LLM provider abstraction.
//
// All keys are read from process.env and never leave the server. If no key is
// configured the app returns a deterministic mock so every flow stays fully
// functional in demo mode. Providers are tried in preference order.

import "server-only";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ProviderName = "groq" | "openrouter" | "cerebras" | "gemini";

interface ProviderConfig {
  name: ProviderName;
  token?: string;
  endpoint: string;
  model: string;
}

function providers(): ProviderConfig[] {
  const all: ProviderConfig[] = [
    {
      name: "groq",
      token: process.env.GROQ_TOKEN,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
    },
    {
      name: "openrouter",
      token: process.env.OPENROUTER_TOKEN,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: "meta-llama/llama-3.1-8b-instruct",
    },
    {
      name: "cerebras",
      token: process.env.CEREBRAS_TOKEN,
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      model: "llama3.1-8b",
    },
    {
      name: "gemini",
      token: process.env.GEMINI_TOKEN,
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      model: "gemini-1.5-flash",
    },
  ];

  const preferred = (process.env.AI_PROVIDER || "").toLowerCase();
  const withKeys = all.filter((p) => p.token);
  withKeys.sort((a, b) =>
    a.name === preferred ? -1 : b.name === preferred ? 1 : 0
  );
  return withKeys;
}

/** True when at least one real provider key is configured. */
export function aiEnabled(): boolean {
  return providers().length > 0;
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
  const list = providers();
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
