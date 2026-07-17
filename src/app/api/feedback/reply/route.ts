import { NextResponse } from "next/server";
import { getSession, adminEmails } from "@/lib/session";
import { sbSelect, sbInsert } from "@/lib/runtime-config";
import { sendEmail } from "@/lib/email";

// One threaded reply on a feedback report. Two authors, one shared endpoint:
//  - management (owner/admin) can reply to ANY report (author_role owner/admin)
//    and the reporter is emailed that they got an answer.
//  - a user can reply only to THEIR OWN report (ownership matched by email),
//    author_role 'user'.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const feedbackId = Number(body.feedbackId);
  const text = String(body.body ?? "").trim().slice(0, 2000);
  if (!Number.isFinite(feedbackId) || feedbackId <= 0 || text.length < 1) {
    return NextResponse.json({ error: "feedbackId and body required" }, { status: 400 });
  }

  const rows = await sbSelect<{ id: number; reporter_email: string | null }>(
    "feedback",
    `select=id,reporter_email&id=eq.${feedbackId}&limit=1`
  ).catch(() => []);
  const report = rows[0];
  if (!report) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const isManagement = session.role !== "user";
  const isOwnerOfReport =
    !!report.reporter_email &&
    report.reporter_email.toLowerCase() === session.email.toLowerCase();

  if (!isManagement && !isOwnerOfReport) {
    // A user can never post into someone else's thread.
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const authorRole = isManagement ? (session.role === "owner" ? "owner" : "admin") : "user";
  await sbInsert("feedback_replies", [
    {
      feedback_id: feedbackId,
      author_email: session.email,
      author_role: authorRole,
      body: text,
    },
  ]);

  // Notify the OTHER side by email (best-effort, no-op without a mail key).
  try {
    if (isManagement && report.reporter_email) {
      await sendEmail({
        to: [report.reporter_email],
        subject: "The WheelDeal team replied to your feedback",
        html: `<p>You have a new reply on your feedback:</p><p style="white-space:pre-wrap">${escapeHtml(
          text
        )}</p><p>Open the app and go to Feedback - Your reports to continue.</p>`,
      });
    } else if (!isManagement) {
      const to = await adminEmails();
      await sendEmail({
        to,
        subject: `New user reply on feedback #${feedbackId}`,
        html: `<p>${escapeHtml(session.email)} replied:</p><p style="white-space:pre-wrap">${escapeHtml(
          text
        )}</p>`,
      });
    }
  } catch {
    /* email is best-effort */
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
