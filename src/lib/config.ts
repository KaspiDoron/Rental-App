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
  scope: "ai" | "data" | "messaging" | "email" | "billing" | "auth" | "maps";
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
  { name: "MISTRAL_TOKEN", label: "Mistral Gateway (free tier)", scope: "ai", editable: true },
  { name: "HUGGINGFACE_TOKEN", label: "Hugging Face Gateway (free tier)", scope: "ai", editable: true },
  { name: "AI_PROVIDER", label: "Preferred AI provider", scope: "ai", editable: true },
  { name: "EVOLUTION_HOSTS", label: "Evolution host pool (url|key per line)", scope: "messaging", editable: true },
  { name: "EVOLUTION_MAX_PER_HOST", label: "Max WhatsApp users per host", scope: "messaging", editable: true },
  { name: "EVOLUTION_API_URL", label: "Evolution API URL (single-host fallback)", scope: "messaging", editable: true },
  { name: "EVOLUTION_API_KEY", label: "Evolution API Key (single-host fallback)", scope: "messaging", editable: true },
  { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp Cloud API Token (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp Phone Number ID (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_VERIFY_TOKEN", label: "WhatsApp Webhook Verify Token (optional)", scope: "messaging", editable: true },
  { name: "GOOGLE_MAPS_API_KEY", label: "Google Maps API Key", scope: "maps", editable: true },
  { name: "GOOGLE_OAUTH_CLIENT_ID", label: "Google OAuth Client ID", scope: "auth", editable: true },
  { name: "RESEND_API_KEY", label: "Resend Email API Key", scope: "email", editable: true },
  { name: "FEEDBACK_FROM_EMAIL", label: "Feedback From Address", scope: "email", editable: true },
  { name: "LEMONSQUEEZY_API_KEY", label: "Lemon Squeezy API Key", scope: "billing", editable: true },
  { name: "LEMONSQUEEZY_STORE_ID", label: "Lemon Squeezy Store ID", scope: "billing", editable: true },
  { name: "LEMONSQUEEZY_VARIANT_PRO", label: "Lemon Squeezy Variant ID - Pro", scope: "billing", editable: true },
  { name: "LEMONSQUEEZY_VARIANT_ULTRA", label: "Lemon Squeezy Variant ID - Ultra", scope: "billing", editable: true },
  { name: "LEMONSQUEEZY_WEBHOOK_SECRET", label: "Lemon Squeezy Webhook Secret", scope: "billing", editable: true },
  { name: "ADSENSE_CLIENT", label: "Google AdSense Client (ca-pub-...)", scope: "billing", editable: true },
  { name: "TWITTER_HANDLE", label: "X (Twitter) handle (@wheeldeal)", scope: "auth", editable: true },
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase URL", scope: "data", editable: false },
  { name: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase Service Role", scope: "data", editable: false },
  { name: "SESSION_SECRET", label: "Session Signing Secret", scope: "auth", editable: false },
];

function mask(v?: string): string {
  if (!v) return "- not set -";
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
): Promise<{ key: KeyInfo; warning?: string } | null> {
  const meta = KEYS.find((k) => k.name === name);
  if (!meta || !meta.editable) return null;
  const result = await setConfig(name, value);
  const v = await getConfig(name);
  return {
    key: {
      name,
      label: meta.label,
      scope: meta.scope,
      editable: meta.editable,
      configured: Boolean(v),
      masked: mask(v),
    },
    warning: result.error,
  };
}

/** OWNER ONLY: raw values for every managed key, ready to view and copy. */
export async function revealKeys(): Promise<
  { name: string; label: string; value: string }[]
> {
  return Promise.all(
    KEYS.map(async (k) => ({
      name: k.name,
      label: k.label,
      value: (await getConfig(k.name)) ?? "",
    }))
  );
}
