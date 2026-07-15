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
  docUrl?: string; // where to generate this key (shown when it is missing)
}

// Where to obtain each key - a "Get key" link surfaces when the key is unset.
const DOC_URLS: Record<string, string> = {
  GROQ_TOKEN: "https://console.groq.com/keys",
  GEMINI_TOKEN: "https://aistudio.google.com/app/apikey",
  OPENROUTER_TOKEN: "https://openrouter.ai/keys",
  CEREBRAS_TOKEN: "https://cloud.cerebras.ai/",
  MISTRAL_TOKEN: "https://console.mistral.ai/api-keys/",
  HUGGINGFACE_TOKEN: "https://huggingface.co/settings/tokens",
  DEEPSEEK_TOKEN: "https://platform.deepseek.com/api_keys",
  TOGETHER_TOKEN: "https://api.together.ai/settings/api-keys",
  SAMBANOVA_TOKEN: "https://cloud.sambanova.ai/apis",
  EVOLUTION_HOSTS: "https://doc.evolution-api.com/",
  EVOLUTION_API_URL: "https://doc.evolution-api.com/",
  EVOLUTION_API_KEY: "https://doc.evolution-api.com/",
  EVOLUTION_PROXY: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  EVOLUTION_PROXY_POOL: "https://doc.evolution-api.com/v2/en/configuration/proxy",
  WHATSAPP_ACCESS_TOKEN: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  WHATSAPP_PHONE_NUMBER_ID: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
  WHATSAPP_VERIFY_TOKEN: "https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks",
  GOOGLE_MAPS_API_KEY: "https://console.cloud.google.com/google/maps-apis/credentials",
  GOOGLE_OAUTH_CLIENT_ID: "https://console.cloud.google.com/apis/credentials",
  GMAIL_USER: "https://myaccount.google.com/security",
  GMAIL_APP_PASSWORD: "https://myaccount.google.com/apppasswords",
  RESEND_API_KEY: "https://resend.com/api-keys",
  BREVO_API_KEY: "https://app.brevo.com/settings/keys/api",
  BREVO_SENDER: "https://app.brevo.com/senders",
  LEMONSQUEEZY_API_KEY: "https://app.lemonsqueezy.com/settings/api",
  LEMONSQUEEZY_STORE_ID: "https://app.lemonsqueezy.com/settings/stores",
  LEMONSQUEEZY_VARIANT_PRO: "https://app.lemonsqueezy.com/products",
  LEMONSQUEEZY_VARIANT_ULTRA: "https://app.lemonsqueezy.com/products",
  LEMONSQUEEZY_WEBHOOK_SECRET: "https://app.lemonsqueezy.com/settings/webhooks",
  ADSENSE_CLIENT: "https://www.google.com/adsense/",
  TWITTER_HANDLE: "https://x.com/settings/profile",
};

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
  { name: "MISTRAL_TOKEN", label: "Mistral (mistral-large - top tier)", scope: "ai", editable: true },
  { name: "HUGGINGFACE_TOKEN", label: "Hugging Face (Llama 3.3 70B - free)", scope: "ai", editable: true },
  { name: "DEEPSEEK_TOKEN", label: "DeepSeek (deepseek-chat - top tier)", scope: "ai", editable: true },
  { name: "TOGETHER_TOKEN", label: "Together AI (Llama 3.3 70B - free)", scope: "ai", editable: true },
  { name: "SAMBANOVA_TOKEN", label: "SambaNova (Llama 3.3 70B - fast, free)", scope: "ai", editable: true },
  { name: "AI_PROVIDER", label: "Preferred AI provider", scope: "ai", editable: true },
  { name: "GRAPH_ENGINE", label: "Negotiation engine ('off' = legacy pipeline)", scope: "ai", editable: true },
  { name: "EVOLUTION_HOSTS", label: "Evolution host pool (url|key per line)", scope: "messaging", editable: true },
  { name: "EVOLUTION_MAX_PER_HOST", label: "Max WhatsApp users per host", scope: "messaging", editable: true },
  { name: "EVOLUTION_PROXY", label: "Residential proxy URL (anti-ban - socks5://user:pass@host:port)", scope: "messaging", editable: true },
  { name: "EVOLUTION_PROXY_POOL", label: "Residential proxy POOL (one URL per line - each user pinned to one)", scope: "messaging", editable: true },
  { name: "EVOLUTION_API_URL", label: "Evolution API URL (single-host fallback)", scope: "messaging", editable: true },
  { name: "EVOLUTION_API_KEY", label: "Evolution API Key (single-host fallback)", scope: "messaging", editable: true },
  { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp Cloud API Token (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp Phone Number ID (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_VERIFY_TOKEN", label: "WhatsApp Webhook Verify Token (optional)", scope: "messaging", editable: true },
  { name: "WHATSAPP_APP_SECRET", label: "WhatsApp App Secret (verifies inbound webhook signatures)", scope: "messaging", editable: true },
  { name: "VAPID_PUBLIC_KEY", label: "Web Push VAPID public key (reply alerts - run: npx web-push generate-vapid-keys)", scope: "messaging", editable: true },
  { name: "VAPID_PRIVATE_KEY", label: "Web Push VAPID private key", scope: "messaging", editable: true },
  { name: "GOOGLE_MAPS_API_KEY", label: "Google Maps API Key", scope: "maps", editable: true },
  { name: "GOOGLE_OAUTH_CLIENT_ID", label: "Google OAuth Client ID", scope: "auth", editable: true },
  { name: "GMAIL_USER", label: "Gmail address (free SMTP - preferred)", scope: "email", editable: true },
  { name: "GMAIL_APP_PASSWORD", label: "Gmail App Password (Google Account -> Security -> App passwords)", scope: "email", editable: true },
  { name: "RESEND_API_KEY", label: "Resend Email API Key (needs a domain)", scope: "email", editable: true },
  { name: "BREVO_API_KEY", label: "Brevo Email API Key (no domain needed)", scope: "email", editable: true },
  { name: "BREVO_SENDER", label: "Brevo verified sender email", scope: "email", editable: true },
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
        docUrl: DOC_URLS[k.name],
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
