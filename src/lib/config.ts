// Admin configuration surface.
//
// SECURITY: secret values are NEVER sent to the browser. The admin panel only
// ever receives a masked fingerprint (last 4 chars) and a configured/missing
// status. Runtime overrides set here live in a server-only in-memory map for
// the current instance; the source of truth for production remains the host's
// encrypted environment variables.

import "server-only";

export interface KeyInfo {
  name: string;
  label: string;
  configured: boolean;
  masked: string;
  scope: "ai" | "data" | "messaging" | "auth";
}

const KEYS: { name: string; label: string; scope: KeyInfo["scope"] }[] = [
  { name: "GROQ_TOKEN", label: "Groq Gateway", scope: "ai" },
  { name: "GEMINI_TOKEN", label: "Gemini Gateway", scope: "ai" },
  { name: "OPENROUTER_TOKEN", label: "OpenRouter Gateway", scope: "ai" },
  { name: "CEREBRAS_TOKEN", label: "Cerebras Gateway", scope: "ai" },
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase URL", scope: "data" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase Service Role", scope: "data" },
  { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp Cloud API Token", scope: "messaging" },
  { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp Phone Number ID", scope: "messaging" },
  { name: "SESSION_SECRET", label: "Session Signing Secret", scope: "auth" },
];

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_overrides__: Map<string, string> | undefined;
}

function overrides() {
  if (!globalThis.__wheeldeal_overrides__)
    globalThis.__wheeldeal_overrides__ = new Map();
  return globalThis.__wheeldeal_overrides__;
}

function valueOf(name: string): string | undefined {
  return overrides().get(name) ?? process.env[name];
}

function mask(v?: string): string {
  if (!v) return "— not set —";
  if (v.length <= 6) return "••••";
  return `${"•".repeat(Math.min(20, v.length - 4))}${v.slice(-4)}`;
}

/** Masked, browser-safe view of every managed credential. */
export function listKeys(): KeyInfo[] {
  return KEYS.map((k) => {
    const v = valueOf(k.name);
    return {
      name: k.name,
      label: k.label,
      scope: k.scope,
      configured: Boolean(v),
      masked: mask(v),
    };
  });
}

/** Apply a runtime override for the current server instance. Returns masked. */
export function setKey(name: string, value: string): KeyInfo | null {
  const meta = KEYS.find((k) => k.name === name);
  if (!meta) return null;
  if (value) overrides().set(name, value);
  else overrides().delete(name);
  const v = valueOf(name);
  return {
    name,
    label: meta.label,
    scope: meta.scope,
    configured: Boolean(v),
    masked: mask(v),
  };
}
