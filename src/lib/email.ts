// Transactional email via Resend (free tier). No-op when unconfigured so the
// rest of the flow (AI filtering, storage) still works without an email key.

import "server-only";
import { getConfig } from "./runtime-config";

export interface Attachment {
  filename: string;
  content: string; // base64 (no data: prefix)
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  error?: string;
  reason?: "unconfigured" | "error";
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<EmailResult> {
  const apiKey = await getConfig("RESEND_API_KEY");
  const from =
    (await getConfig("FEEDBACK_FROM_EMAIL")) || "WheelDeal <onboarding@resend.dev>";
  if (!apiKey) return { sent: false, reason: "unconfigured" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.attachments,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { sent: false, reason: "error", error: data?.message ?? `resend ${res.status}` };
    }
    return { sent: true, id: data?.id };
  } catch (e) {
    return {
      sent: false,
      reason: "error",
      error: e instanceof Error ? e.message : "network error",
    };
  }
}
