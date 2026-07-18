// Official Meta WhatsApp Cloud API integration.
//
// When WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are configured, outbound
// messages go through the Graph API to opted-in partner vendors. Otherwise we
// return a compliant click-to-chat (wa.me) deep link the user can send
// themselves - no scraping, no unsolicited bulk blasting.

import "server-only";
import { getConfig } from "./runtime-config";
import { digitsOnly } from "./phone";

export interface SendResult {
  channel: "cloud-api" | "click-to-chat";
  ok: boolean;
  waLink?: string;
  messageId?: string;
  error?: string;
}

export async function whatsappConfigured(): Promise<boolean> {
  const [token, phoneId] = await Promise.all([
    getConfig("WHATSAPP_ACCESS_TOKEN"),
    getConfig("WHATSAPP_PHONE_NUMBER_ID"),
  ]);
  return Boolean(token && phoneId);
}

function clickToChat(to: string, message: string): SendResult {
  const num = digitsOnly(to);
  const waLink = `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
  return { channel: "click-to-chat", ok: true, waLink };
}

export async function sendWhatsApp(
  to: string,
  message: string
): Promise<SendResult> {
  const [token, phoneId] = await Promise.all([
    getConfig("WHATSAPP_ACCESS_TOKEN"),
    getConfig("WHATSAPP_PHONE_NUMBER_ID"),
  ]);
  if (!token || !phoneId) return clickToChat(to, message);

  // Hard 12s timeout: a stalled Graph API response must not hang the outreach
  // request for the full Vercel maxDuration. On abort fetch throws -> the catch
  // below returns an error result (transient on the drain path -> re-queued).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: digitsOnly(to),
          type: "text",
          text: { body: message },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      return {
        channel: "cloud-api",
        ok: false,
        error: data?.error?.message ?? `Graph API ${res.status}`,
      };
    }
    return {
      channel: "cloud-api",
      ok: true,
      messageId: data?.messages?.[0]?.id,
    };
  } catch (e) {
    return {
      channel: "cloud-api",
      ok: false,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}
