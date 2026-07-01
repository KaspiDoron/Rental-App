import { NextResponse } from "next/server";
import { triageFeedback } from "@/lib/agents";
import { sendEmail } from "@/lib/email";
import { sbInsert } from "@/lib/runtime-config";
import { adminEmails } from "@/lib/session";

interface ImagePayload {
  filename: string;
  dataUrl: string; // data:<mime>;base64,<data>
}

const MAX_IMAGES = 5;

function parseImages(images: ImagePayload[] | undefined) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, MAX_IMAGES).flatMap((img) => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(img.dataUrl || "");
    if (!m) return [];
    return [{ filename: img.filename || "screenshot.png", content: m[2] }];
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.text || !body?.category) {
    return NextResponse.json(
      { error: "Category and description are required." },
      { status: 400 }
    );
  }
  const text = String(body.text).slice(0, 4000);
  const category = String(body.category);
  const email = typeof body.email === "string" ? body.email.slice(0, 200) : "";
  const attachments = parseImages(body.images);

  // Feedback Triage Agent: keep genuine issues, filter spam before emailing.
  const verdict = await triageFeedback(category, text);

  // Always store the raw submission (with the verdict) for the admin vault.
  await sbInsert("feedback", [
    {
      category,
      body: text,
      reporter_email: email || null,
      is_real_issue: verdict.isRealIssue,
      severity: verdict.severity,
      summary: verdict.summary,
      triage_reason: verdict.reason,
      image_count: attachments.length,
    },
  ]);

  if (!verdict.isRealIssue) {
    return NextResponse.json({
      accepted: false,
      reason:
        "Thanks! Our assistant reviewed this and didn't flag a concrete bug, so it wasn't escalated. Add more detail (what happened, steps) to send it through.",
    });
  }

  // Escalate real issues to management by email (no-op without RESEND_API_KEY).
  const to = adminEmails();
  const emailResult = await sendEmail({
    to,
    subject: `[WheelDeal ${verdict.severity.toUpperCase()}] ${verdict.summary}`,
    html: `
      <h2>New verified feedback</h2>
      <p><b>Category:</b> ${escapeHtml(category)}</p>
      <p><b>Severity:</b> ${verdict.severity}</p>
      <p><b>From:</b> ${escapeHtml(email || "anonymous")}</p>
      <p><b>Triage:</b> ${escapeHtml(verdict.reason)}</p>
      <hr/>
      <p style="white-space:pre-wrap">${escapeHtml(text)}</p>
      <p><i>${attachments.length} image(s) attached.</i></p>
    `,
    attachments,
  });

  return NextResponse.json({
    accepted: true,
    severity: verdict.severity,
    summary: verdict.summary,
    emailed: emailResult.sent,
    emailReason: emailResult.reason,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
