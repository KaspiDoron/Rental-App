// Admin configuration surface (Key Vault).
//
// SECURITY: secret values are NEVER sent to the browser. The admin panel only
// ever receives a masked fingerprint (last 4 chars) and a configured/missing
// status. Values set here are persisted via runtime-config (Supabase, encrypted
// at rest) when Supabase is configured, so they survive serverless restarts and
// take effect at the next request without a redeploy.

import "server-only";
import { getConfig, setConfig, supabaseConfigured } from "./runtime-config";

export interface KeyInfo {
  name: string;
  label: string;
  configured: boolean;
  masked: string;
  scope: "ai" | "data" | "messaging" | "auth";
  editable: boolean;
}

// Keys that can be set from the admin panel at runtime. Bootstrap secrets
// (Supabase connection, SESSION_SECRET) are intentionally env-only.
const KEYS: {
  name: string;
  label: string;
  scope: KeyInfo["scope"];
  editable: boolean;
}[] = [
  { name: "GROQ_TOKEN", label: "Groq Gateway", scope: "ai", editable: true },
  { name: "GEMINI_TOKEN", label: "Gemini Gateway", scope: "ai", editable: true },
  { name: "OPENROUTER_TOKEN", label: "OpenRouter Gateway", scope: "ai", editable: true },
  { name: "CEREBRAS_TOKEN", label: "Cerebras Gateway", scope: "ai", editable: true },
  { name: "AI_PROVIDER", label: "Preferred AI provider", scope: "ai", editable: true },
  { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp Cloud API Token", scope: "messaging", editable: true },
  { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp Phone Number ID", scope: "messaging", editable: true },
  { name: "WHATSAPP_VERIFY_TOKEN", label: "WhatsApp Webhook Verify Token", scope: "messaging", editable: true },
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase URL", scope: "data", editable: false },
  { name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase Service Role", scope: "data", editable: false },
  { name: "SESSION_SECRET", label: "Session Signing Secret", scope: "auth", editable: false },
];

function mask(v?: string): string {
  if (!v) return "— not set —";
  if (v.length <= 6) return "••••";
  return `${"•".repeat(Math.min(20, v.length - 4))}${v.slice(-4)}`;
}

/** True when runtime edits will persist (Supabase configured). */
export function persistenceEnabled(): boolean {
  return supabaseConfigured();
}

/** Masked, browser-safe view of every managed credential. */
export async function listKeys(): Promise<KeyInfo[]> {
  return Promise.all(
    KEYS.map(async (k) => {
      const v = await getConfig(k.name);
      return {
        name: k.name,
        label: k.label,
        scope: k.scope,
        editable: k.editable,
        configured: Boolean(v),
        masked: mask(v),
      };
    })
  );
}

/** Apply a runtime override. Returns the masked view (never the raw secret). */
export async function setKey(
  name: string,
  value: string
): Promise<KeyInfo | null> {
  const meta = KEYS.find((k) => k.name === name);
  if (!meta || !meta.editable) return null;
  await setConfig(name, value);
  const v = await getConfig(name);
  return {
    name,
    label: meta.label,
    scope: meta.scope,
    editable: meta.editable,
    configured: Boolean(v),
    masked: mask(v),
  };
}
