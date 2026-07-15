import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { emailProviderStatus, sendEmail } from "@/lib/email";

// Email live test (owner/manager only): reports which providers are configured
// and, on POST, sends a REAL email through the exact production chain
// (Gmail -> Brevo -> Resend) to the signed-in admin's own address - turning "I
// entered the env values" into a one-tap verified fact.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const status = await emailProviderStatus();
  return NextResponse.json({ status, to: session.email });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const status = await emailProviderStatus();
  if (!status.anyConfigured) {
    return NextResponse.json({
      sent: false,
      status,
      error:
        "No email provider configured. Add GMAIL_USER + GMAIL_APP_PASSWORD, or BREVO_API_KEY, or RESEND_API_KEY in Keys.",
    });
  }

  const body = await req.json().catch(() => ({}));
  const to = String(body.to || session.email).trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));

  const result = await sendEmail({
    to: [to],
    subject: "WheelDeal email test ✅",
    html:
      `<div style="font-family:sans-serif">` +
      `<h2>Your email pipeline works 🎉</h2>` +
      `<p>This is a live test from Admin. If you received it, signup verification codes and password resets will reach your travellers.</p>` +
      `<p style="font-size:22px;font-weight:800;letter-spacing:4px">${code}</p>` +
      `<p style="color:#888;font-size:12px">Sent to ${to}.</p>` +
      `</div>`,
  });

  // Actionable hints for the common real-world failures.
  let hint: string | undefined;
  if (!result.sent) {
    if (status.resendSandbox && result.provider === "resend") {
      hint =
        "Resend sandbox (onboarding@resend.dev) only delivers to your own Resend account email until you verify a domain and set FEEDBACK_FROM_EMAIL to an address on it.";
    } else if (result.provider === "gmail") {
      hint = "Gmail needs an App Password (2-Step Verification on), not your normal password.";
    } else if (result.provider === "brevo") {
      hint = "Brevo requires BREVO_SENDER to be a verified sender address.";
    }
  } else if (status.resendSandbox && result.provider === "resend" && to !== status.sender) {
    hint =
      "Sent via Resend sandbox - it only actually delivers to your Resend account's own email until you verify a domain.";
  }

  return NextResponse.json({
    sent: result.sent,
    provider: result.provider,
    to,
    error: result.error,
    hint,
    status,
  });
}

export const maxDuration = 60;
