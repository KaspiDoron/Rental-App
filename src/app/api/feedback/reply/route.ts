import { NextResponse } from "next/server";
import { getSession, adminEmails } from "@/lib/session";
import { sbSelect, sbInsert } from "@/lib/runtime-config";
import { sendEmail } from "@/lib/email";
import { moderateFeedback } from "@/lib/feedback/moderation";

// One threaded reply on a feedback report. Two authors, one shared endpoint:
//  - management (owner/admin) can reply to ANY report (author_role owner/admin)
//    and the reporter is emailed that they got an answer.
//  - a user can reply only to THEIR OWN report (ownership matched by email),
//    author_role 'user'.
//
// HALF THE FEEDBACK PAGE IS THIS THREAD, AND IT WAS COMPLETELY UNSCREENED.
//
// The owner asked for a "safe words feedback page". `moderateFeedback` had
// exactly ONE caller in the repo - POST /api/feedback - so the opening message
// was screened and every reply after it was not: this route took the text
// straight to the insert, and any slur or threat was stored verbatim, rendered
// to the owner in the admin panel, and emailed to every admin address. A screen
// on one of two doors is not a screen.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // M6 (owner report 6): the moderation screen below is an LLM call, so an
  // unthrottled loop was paid AI spend even when every reply got rejected.
  // Session-keyed - 10 thread replies an hour is far beyond any real
  // conversation; management is exempt (answering a busy inbox is the job).
  if (session.role === "user") {
    const { rateLimit } = await import("@/lib/rate-limit");
    const gate = await rateLimit("feedback-reply", session.email, 10, 3600);
    if (!gate.ok) {
      return NextResponse.json(
        { error: "That's a lot of replies in a row - give it a little while and try again." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfter) } }
      );
    }
  }

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

  // THE SAME SCREEN THE OPENING MESSAGE GETS, BEFORE ANYTHING IS STORED OR
  // EMAILED. Model first, deterministic floor underneath (lib/feedback/
  // moderation). Applied to BOTH authors on purpose: a thread is read by both
  // sides, and a rule that exempts whoever happens to hold the admin cookie is
  // not a rule about the page. Anger at the product still passes - the
  // moderator is told so in as many words.
  const moderation = await moderateFeedback(text);
  if (!moderation.allowed) {
    return NextResponse.json(
      {
        error:
          moderation.message ?? "Please rephrase this without the language and send it again.",
        rejected: "language",
        stored: false,
      },
      { status: 400 }
    );
  }

  // A REPLY THAT NEVER PERSISTED MUST NOT ANSWER {ok:true}.
  //
  // `sbInsert` returns a BOOLEAN - false on no connection, a 404, an RLS
  // refusal or a network error - and this route discarded it and returned
  // `{ok:true}` regardless. Both UIs then optimistically painted the reply as
  // sent. The most plausible field repro is the owner's own complaint that
  // users cannot see his responses: a deployment whose schema predates the
  // feedback-threads block has no `feedback_replies` table at all, so every
  // owner reply returned 200, painted, and vanished. This is the identical
  // dishonesty the POST /api/feedback route already fixed with its `stored`
  // flag, left un-fixed one file over.
  const stored = await sbInsert("feedback_replies", [
    {
      feedback_id: feedbackId,
      author_email: session.email,
      author_role: isManagement ? (session.role === "owner" ? "owner" : "admin") : "user",
      body: text,
    },
  ]).catch(() => false);

  if (!stored) {
    // 502, so `res.ok` is false and no client can paint this as delivered. No
    // email either: notifying the other side about a message that does not
    // exist sends them to a thread that will never show it.
    return NextResponse.json(
      {
        ok: false,
        stored: false,
        error: "We could not save that reply just now - it was not sent. Please try again.",
      },
      { status: 502 }
    );
  }

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

  return NextResponse.json({ ok: true, stored: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
