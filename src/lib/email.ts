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

// Brevo (formerly Sendinblue): REST API, 300 free emails/day, single verified
// sender (no domain needed). Sender = BREVO_SENDER (must be a verified email),
// falling back to FEEDBACK_FROM_EMAIL's address.
async function sendViaBrevo(
  apiKey: string,
  opts: { to: string[]; subject: string; html: string }
): Promise<EmailResult> {
  const senderRaw = (await getConfig("BREVO_SENDER")) || (await getConfig("FEEDBACK_FROM_EMAIL")) || "";
  const m = /<([^>]+)>/.exec(senderRaw);
  const senderEmail = (m ? m[1] : senderRaw).trim();
  if (!senderEmail || !senderEmail.includes("@")) {
    return { sent: false, reason: "error", error: "Set BREVO_SENDER to your verified sender email." };
  }
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: senderEmail, name: "WheelDeal" },
        to: opts.to.map((e) => ({ email: e })),
        subject: opts.subject,
        htmlContent: opts.html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, reason: "error", error: data?.message ?? `brevo ${res.status}` };
    return { sent: true, id: data?.messageId };
  } catch (e) {
    return { sent: false, reason: "error", error: e instanceof Error ? e.message : "network error" };
  }
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<EmailResult> {
  // Brevo first when configured: it allows sending from a SINGLE verified sender
  // email (e.g. your Gmail) with NO custom domain, so verification codes reach
  // real users on the free tier. Resend needs a verified domain, so it is the
  // fallback (fine once you own a domain).
  const brevoKey = await getConfig("BREVO_API_KEY");
  if (brevoKey && !opts.attachments?.length) {
    const brevo = await sendViaBrevo(brevoKey, opts);
    if (brevo.sent || brevo.reason === "error") return brevo;
  }

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
