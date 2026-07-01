// Official Meta WhatsApp Cloud API integration.
//
// When WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are configured, outbound
// messages go through the Graph API to opted-in partner vendors. Otherwise we
// return a compliant click-to-chat (wa.me) deep link the user can send
// themselves — no scraping, no unsolicited bulk blasting.

import "server-only";

export interface SendResult {
  channel: "cloud-api" | "click-to-chat";
  ok: boolean;
  waLink?: string;
  messageId?: string;
  error?: string;
}

export function whatsappConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

function clickToChat(to: string, message: string): SendResult {
  const num = to.replace(/[^\d]/g, "");
  const waLink = `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
  return { channel: "click-to-chat", ok: true, waLink };
}

export async function sendWhatsApp(
  to: string,
  message: string
): Promise<SendResult> {
  if (!whatsappConfigured()) return clickToChat(to, message);

  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to.replace(/[^\d]/g, ""),
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
