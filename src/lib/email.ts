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
  // Which provider handled (or attempted) the send - surfaced by the live test.
  provider?: "gmail" | "brevo" | "resend";
}

/** Which email providers are configured right now (never leaks the values). */
export async function emailProviderStatus(): Promise<{
  gmail: boolean;
  brevo: boolean;
  resend: boolean;
  anyConfigured: boolean;
  resendSandbox: boolean;
  sender: string | null;
}> {
  const [gmailUser, gmailPass, brevo, resend, from, brevoSender] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
    getConfig("BREVO_API_KEY"),
    getConfig("RESEND_API_KEY"),
    getConfig("FEEDBACK_FROM_EMAIL"),
    getConfig("BREVO_SENDER"),
  ]);
  const gmail = Boolean(gmailUser && gmailPass);
  const sender = from || brevoSender || (gmailUser ? `WheelDeal <${gmailUser}>` : null);
  return {
    gmail,
    brevo: Boolean(brevo),
    resend: Boolean(resend),
    anyConfigured: gmail || Boolean(brevo) || Boolean(resend),
    // Resend's shared sandbox sender only delivers to the account owner until a
    // domain is verified - the #1 "I set the key but got no email" gotcha.
    resendSandbox: Boolean(resend) && (!from || /onboarding@resend\.dev/i.test(from)),
    sender,
  };
}

export interface EmailProbe {
  provider: "gmail" | "brevo" | "resend";
  configured: boolean;
  /**
   * TRUE means a credential was actually exercised against the provider.
   * The health roll-call used to call `emailVerificationAvailable()` - which
   * only asks whether a STRING is present - and print HEALTHY. A revoked
   * Gmail app password, a deleted Brevo key and a perfect setup all rendered
   * identically, on the path that delivers signup codes.
   */
  live: boolean;
  detail: string;
}

/**
 * ONE LIVE CREDENTIAL CHECK PER CONFIGURED EMAIL PROVIDER (Wave 7).
 *
 * Gmail: nodemailer's `verify()` opens the real SMTP session and AUTHs,
 * without sending anything - so a revoked App Password fails here, which is
 * the whole point. Brevo/Resend: an authenticated GET on an account-scoped
 * endpoint. Nothing is sent to anybody, so this is safe to press repeatedly.
 */
export async function emailLiveProbe(): Promise<EmailProbe[]> {
  const [gmailUser, gmailPass, brevo, resend] = await Promise.all([
    getConfig("GMAIL_USER"),
    getConfig("GMAIL_APP_PASSWORD"),
    getConfig("BREVO_API_KEY"),
    getConfig("RESEND_API_KEY"),
  ]);

  const gmailProbe = async (): Promise<EmailProbe> => {
    if (!gmailUser || !gmailPass) {
      return { provider: "gmail", configured: false, live: false, detail: "Not configured." };
    }
    try {
      const nodemailer = (await import("nodemailer")).default;
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: gmailUser.trim(), pass: gmailPass.replace(/\s+/g, "") },
      });
      await transporter.verify();
      return {
        provider: "gmail",
        configured: true,
        live: true,
        detail: `SMTP AUTH accepted for ${gmailUser.trim()} (live check, nothing sent).`,
      };
    } catch (e) {
      return {
        provider: "gmail",
        configured: true,
        live: false,
        detail: `SMTP rejected the App Password: ${e instanceof Error ? e.message : "connect failed"}`,
      };
    }
  };

  const brevoProbe = async (): Promise<EmailProbe> => {
    if (!brevo) return { provider: "brevo", configured: false, live: false, detail: "Not configured." };
    try {
      const res = await fetch("https://api.brevo.com/v3/account", {
        headers: { "api-key": brevo.trim(), Accept: "application/json" },
        cache: "no-store",
      });
      const d = (await res.json().catch(() => ({}))) as { email?: string; message?: string };
      return res.ok
        ? { provider: "brevo", configured: true, live: true, detail: `Key accepted (${d.email ?? "account reachable"}).` }
        : { provider: "brevo", configured: true, live: false, detail: d.message ?? `Brevo responded ${res.status}.` };
    } catch (e) {
      return { provider: "brevo", configured: true, live: false, detail: e instanceof Error ? e.message : "network error" };
    }
  };

  const resendProbe = async (): Promise<EmailProbe> => {
    if (!resend) return { provider: "resend", configured: false, live: false, detail: "Not configured." };
    try {
      const res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${resend.trim()}` },
        cache: "no-store",
      });
      return res.ok
        ? { provider: "resend", configured: true, live: true, detail: "Key accepted." }
        : { provider: "resend", configured: true, live: false, detail: `Resend responded ${res.status}.` };
    } catch (e) {
      return { provider: "resend", configured: true, live: false, detail: e instanceof Error ? e.message : "network error" };
    }
  };

  return Promise.all([gmailProbe(), brevoProbe(), resendProbe()]);
}

/**
 * The one sentence the health roll-call prints, and whether it was EARNED by a
 * live call. `kind` is the honesty flag: "live" when at least one credential
 * was exercised, "config" when all we know is that a string is present.
 */
export function summariseEmailProbes(probes: EmailProbe[]): {
  status: "ok" | "degraded" | "down" | "off";
  kind: "live" | "config";
  detail: string;
} {
  const configured = probes.filter((p) => p.configured);
  if (configured.length === 0) {
    return {
      status: "off",
      kind: "config",
      detail: "No email key - invited testers sign up WITHOUT a code.",
    };
  }
  const live = configured.filter((p) => p.live);
  const dead = configured.filter((p) => !p.live);
  if (live.length === 0) {
    return {
      status: "down",
      kind: "live",
      detail: `LIVE CHECK FAILED on every configured provider - signup codes will NOT send. ${dead
        .map((p) => `${p.provider}: ${p.detail}`)
        .join(" | ")}`,
    };
  }
  return {
    status: dead.length ? "degraded" : "ok",
    kind: "live",
    detail:
      `LIVE CHECK: ${live.map((p) => p.provider).join(", ")} accepted the credential.` +
      (dead.length ? ` Failing: ${dead.map((p) => `${p.provider} (${p.detail})`).join(" | ")}` : ""),
  };
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
    if (gmail.sent) return { ...gmail, provider: "gmail" };
    // On a hard Gmail failure fall through to the other providers.
  }

  const brevoKey = await getConfig("BREVO_API_KEY");
  if (brevoKey && !opts.attachments?.length) {
    const brevo = await sendViaBrevo(brevoKey, opts);
    if (brevo.sent || brevo.reason === "error") return { ...brevo, provider: "brevo" };
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
      return { sent: false, reason: "error", error: data?.message ?? `resend ${res.status}`, provider: "resend" };
    }
    return { sent: true, id: data?.id, provider: "resend" };
  } catch (e) {
    return {
      sent: false,
      reason: "error",
      error: e instanceof Error ? e.message : "network error",
      provider: "resend",
    };
  }
}
