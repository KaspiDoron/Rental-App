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

// Gmail SMTP with an App Password: 100% free, no custom domain, no IP
// allowlist, ~500 emails/day - the zero-cost default. Setup: Google Account
// -> Security -> 2-Step Verification -> App passwords -> paste GMAIL_USER
// (your Gmail address) + GMAIL_APP_PASSWORD into Admin -> Keys.
async function sendViaGmail(
  user: string,
  appPassword: string,
  opts: { to: string[]; subject: string; html: string; attachments?: Attachment[] }
): Promise<EmailResult> {
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass: appPassword.replace(/\s+/g, "") },
    });
    const info = await transporter.sendMail({
      from: `WheelDeal <${user}>`,
      to: opts.to.join(", "),
      subject: opts.subject,
      html: opts.html,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        encoding: "base64" as const,
      })),
    });
    return { sent: true, id: info.messageId };
  } catch (e) {
    return {
      sent: false,
      reason: "error",
      error: e instanceof Error ? e.message : "smtp error",
    };
  }
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<EmailResult> {
  // Priority: Gmail SMTP (free, no domain, no IP allowlist, ~500/day) ->
  // Brevo (300/day, single verified sender) -> Resend (needs a domain).
  const [gmailUser, gmailPass] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
  ]);
  if (gmailUser && gmailPass) {
    const gmail = await sendViaGmail(gmailUser, gmailPass, opts);
    if (gmail.sent) return gmail;
    // On a hard Gmail failure fall through to the other providers.
  }

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
