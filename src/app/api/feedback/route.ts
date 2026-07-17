import { NextResponse } from "next/server";
import { triageFeedback } from "@/lib/agents";
import { sendEmail } from "@/lib/email";
import { sbInsert, sbInsertReturning, sbSelect, sbDelete } from "@/lib/runtime-config";
import { adminEmails, getSession } from "@/lib/session";

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
  // Ownership is tied to the SIGNED-IN session (not the spoofable body.email),
  // so "your reports" and self-delete are safe. Anonymous submitters still work
  // via the optional body.email, they just can't list/manage afterwards.
  const session = await getSession();
  const email = session?.email ?? (typeof body.email === "string" ? body.email.slice(0, 200) : "");
  const attachments = parseImages(body.images);

  // Feedback Triage Agent: keep genuine issues, filter spam before emailing.
  const verdict = await triageFeedback(category, text);

  const inserted = await sbInsertReturning<{ id: number }>("feedback", [
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
  const feedbackId = inserted[0]?.id ?? null;

  if (feedbackId !== null && Array.isArray(body.images) && body.images.length) {
    const rows = (body.images as { dataUrl?: string }[])
      .slice(0, MAX_IMAGES)
      .filter((img) => typeof img.dataUrl === "string" && img.dataUrl.startsWith("data:"))
      .map((img) => ({ feedback_id: feedbackId, data_url: img.dataUrl }));
    if (rows.length) await sbInsert("feedback_images", rows);
  }

  if (!verdict.isRealIssue) {
    // Even a filtered item is stored + visible in "your reports" so nothing a
    // user submits ever silently vanishes - they can follow up with detail.
    return NextResponse.json({
      accepted: false,
      id: feedbackId,
      reason:
        "Thanks! Our assistant reviewed this and didn't flag a concrete bug, so it wasn't escalated. Add more detail (what happened, steps) to send it through - you can also reply on it under Your reports.",
    });
  }

  const to = await adminEmails();
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
    id: feedbackId,
    severity: verdict.severity,
    summary: verdict.summary,
    emailed: emailResult.sent,
    emailReason: emailResult.reason,
  });
}

// GET: the signed-in user's OWN submissions, each with its reply thread and
// status, newest first - so feedback is a visible, two-way conversation rather
// than a fire-and-forget box.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const me = encodeURIComponent(session.email);
  const rows = await sbSelect<{
    id: number;
    category: string;
    body: string;
    status: string | null;
    severity: string | null;
    summary: string | null;
    created_at: string;
  }>(
    "feedback",
    `select=id,category,body,status,severity,summary,created_at&reporter_email=eq.${me}&order=created_at.desc&limit=50`
  ).catch(() => []);

  let replies: {
    id: number;
    feedback_id: number;
    author_role: string;
    body: string;
    created_at: string;
  }[] = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id).join(",");
    replies = await sbSelect<{
      id: number;
      feedback_id: number;
      author_role: string;
      body: string;
      created_at: string;
    }>(
      "feedback_replies",
      `select=id,feedback_id,author_role,body,created_at&feedback_id=in.(${ids})&order=created_at.asc&limit=300`
    ).catch(() => []);
  }
  const byId: Record<number, typeof replies> = {};
  for (const r of replies) (byId[r.feedback_id] ??= []).push(r);

  return NextResponse.json({
    reports: rows.map((r) => ({ ...r, replies: byId[r.id] ?? [] })),
  });
}

// DELETE: a user removes their OWN submission (and its thread + screenshots).
// Ownership is enforced by matching reporter_email to the session - never id
// alone, so one user can never delete another's report.
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const me = encodeURIComponent(session.email);
  const owned = await sbSelect<{ id: number }>(
    "feedback",
    `select=id&id=eq.${id}&reporter_email=eq.${me}&limit=1`
  ).catch(() => []);
  if (!owned.length) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await sbDelete("feedback_replies", `feedback_id=eq.${id}`).catch(() => {});
  await sbDelete("feedback_images", `feedback_id=eq.${id}`).catch(() => {});
  await sbDelete("feedback", `id=eq.${id}`);
  return NextResponse.json({ ok: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
